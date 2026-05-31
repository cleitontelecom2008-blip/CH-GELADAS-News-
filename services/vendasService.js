'use strict';
/**
 * services/vendasService.js — CH Geladas PDV
 *
 * REGRA CRÍTICA:
 *   finalizarVenda() é SÍNCRONA — retorna o objeto venda imediatamente.
 *   CartService.finalize() (core.js) depende disso para funcionar.
 *
 *   Operações async (estoque Firebase, financeiro) são fire-and-forget
 *   via _processarEfeitosAsync() — nunca bloqueiam o retorno.
 *
 * FLUXO DE APROVAÇÃO:
 *   Se perfil tem flag "vendas_requer_aprovacao" → status "pendente"
 *     → sem estoque, sem financeiro agora.
 *   Caso contrário → status "concluida" → _processarEfeitosAsync()
 *
 * FLUXO FIADO (v4.2):
 *   formaPgto === 'Fiado' → valida cliente → registra dívida no módulo Fiado
 *   → venda linkada via fiadoClienteId / fiadoDividaId
 *   → cancelarVenda() bloqueado para vendas Fiado (somente fiado.html)
 */

(function () {
  const { Store, AuthService, Utils, EventBus } = window.CH;

  // ── Processa estoque + financeiro em background (fire and forget) ──
  async function _processarEfeitosAsync(venda) {
    const itens = venda.itens || [];

    // Estoque
    const EstoqueService = window.CH.EstoqueService;
    if (EstoqueService) {
      for (const item of itens) {
        try {
          const prod  = EstoqueService.getProduto(item.prodId);
          const pack  = prod?.packs?.find(pk =>
            pk.label === item.label || (pk.qtd + 'x') === item.label
          );
          const qtdUn = item.label === 'UNID' ? item.qtd : item.qtd * (pack?.qtd || 1);
          await EstoqueService.baixarEstoqueVenda(item.prodId, qtdUn, venda.id);
        } catch (e) {
          console.warn(`[VendasService] Estoque falhou "${item.nome}":`, e.message);
        }
      }
    } else {
      Store.mutateEstoque(estoque => {
        itens.forEach(item => {
          const prod = estoque.find(p => p.id === item.prodId);
          if (!prod) return;
          const qtdDesc = item.label === 'UNID'
            ? item.qtd
            : item.qtd * (prod.packs?.find(pk => pk.label === item.label)?.qtd || 1);
          prod.qtdUn = Math.max(0, (prod.qtdUn || 0) - qtdDesc);
          prod.estoqueAtual = prod.qtdUn;
        });
      });
    }

    // Financeiro — registrarReceita é acionado via EventBus.on('venda:finalizada')
    // em financeiroService.js. NÃO chamar diretamente aqui para evitar registro duplo.
  }

  // ══════════════════════════════════════════════════════════════════
  //  REGISTRAR DÍVIDA FIADO — chamado internamente por finalizarVenda
  // ══════════════════════════════════════════════════════════════════
  function _registrarDividaFiado(venda, clienteId) {
    const dividaId = Utils.generateId();

    Store.mutateFiado(fiado => {
      const cliente = fiado.find(c => c.id === clienteId);
      if (!cliente) {
        console.error('[VendasService] Cliente fiado não encontrado:', clienteId);
        return;
      }

      // Snapshot dos itens para rastreabilidade
      const descricao = venda.itens?.length
        ? venda.itens.map(i => `${i.qtd}x ${i.nome}`).join(', ')
        : 'Venda ' + venda.id.slice(-6);

      // Registra movimentação no histórico do cliente
      if (!cliente.movimentacoes) cliente.movimentacoes = [];
      cliente.movimentacoes.unshift({
        id:         dividaId,
        tipo:       'fiado',
        descricao,
        valor:      venda.total,
        vendaId:    venda.id,
        origem:     venda.origem || 'PDV',
        operador:   venda.operador,
        criadoEm:   venda.criadoEm,
        itens:      venda.itens || [],
        status:     'pendente_pgto',
      });

      // Atualiza saldo devedor
      cliente.saldo = (cliente.saldo || 0) + venda.total;

      // Bloqueia cliente se atingiu limite
      if (cliente.limite > 0 && cliente.saldo >= cliente.limite) {
        cliente.bloqueado = true;
      }
    });

    // Sincroniza Fiado com Firebase
    if (window.CH.SyncQueue) {
      window.CH.SyncQueue.enqueue('salvar', 'fiado', Store.getFiado());
    }

    return dividaId;
  }

  // ══════════════════════════════════════════════════════════════════
  //  FINALIZAR VENDA — SÍNCRONO (não async!)
  // ══════════════════════════════════════════════════════════════════
  function finalizarVenda(cart, formaPgto, extras = {}) {
    const itens    = cart.getItems    ? cart.getItems()    : (cart.itens    || []);
    const total    = cart.getTotal    ? cart.getTotal()    : (cart.total    || 0);
    const subtotal = cart.getSubtotal ? cart.getSubtotal() : (cart.subtotal || total);
    const desconto = cart.getDesconto ? cart.getDesconto() : (cart.desconto || 0);

    if (!itens.length) throw new Error('Carrinho vazio');

    // ── GUARDA FIADO: exige cliente ────────────────────────────────
    if (formaPgto === 'Fiado') {
      const clienteId = extras.fiadoClienteId;
      if (!clienteId) {
        throw new Error('FIADO_SEM_CLIENTE: selecione o cliente antes de finalizar');
      }
      const clientes = Store.getFiado();
      const cliente  = clientes.find(c => c.id === clienteId);
      if (!cliente) {
        throw new Error('FIADO_CLIENTE_NAO_ENCONTRADO: cliente não cadastrado no módulo Fiado');
      }
      // Valida limite de crédito (se configurado e não forçado pelo ADM)
      if (cliente.limite > 0 && !extras.forcarFiado) {
        const novoSaldo = (cliente.saldo || 0) + total;
        if (novoSaldo > cliente.limite) {
          throw new Error(`FIADO_LIMITE_EXCEDIDO:${cliente.limite}:${novoSaldo}:${cliente.nome}`);
        }
      }
      // Bloqueia cliente já bloqueado
      if (cliente.bloqueado && !extras.forcarFiado) {
        throw new Error(`FIADO_CLIENTE_BLOQUEADO:${cliente.nome}`);
      }
    }

    const lucro = itens.reduce((s, i) => s + (i.preco - (i.custo || 0)) * i.qtd, 0) - desconto;
    const role  = AuthService.getRole();

    // ── Decisão de aprovação (100% síncrona) ──────────────────────
    const _Perm = window.CH.PermissoesService;
    const _rolesLivres = ['adm', 'admin', 'gerente', 'operador', 'pdv', 'entregador'];
    let requerAprovacao;
    if (_Perm) {
      requerAprovacao = _Perm.getFlag(role, 'vendas_requer_aprovacao');
    } else {
      requerAprovacao = !_rolesLivres.includes(role);
      console.warn('[VendasService] PermissoesService não carregado — usando fallback conservador para role:', role);
    }

    // ── CAMPOS DE RASTREABILIDADE (v4.2) ──────────────────────────
    const clienteFiado = formaPgto === 'Fiado'
      ? Store.getFiado().find(c => c.id === extras.fiadoClienteId)
      : null;

    const venda = {
      id:               Utils.generateId(),
      dataCurta:        Utils.todayISO(),
      data:             Utils.today(),
      hora:             Utils.nowTime(),
      criadoEm:         Utils.nowISO(),
      itens, total, subtotal, desconto, lucro,
      formaPgto:        formaPgto || 'Dinheiro',
      origem:           extras.origem || 'PDV',
      operador:         AuthService.getNome(),
      operadorId:       AuthService.getId?.() || AuthService.getNome(),
      operadorRole:     role,
      filialId:         Store.getConfig?.()?.filialId || null,
      status:           requerAprovacao ? 'pendente' : 'concluida',
      statusPgto:       formaPgto === 'Fiado' ? 'pendente_fiado' : 'pago',
      _fbSynced:        false,
      _troco:           extras.troco           || 0,
      _parcelaDinheiro: extras.parcelaDinheiro || 0,
      _parcelaRestante: extras.parcelaRestante || 0,
      _formaRestante:   extras.formaRestante   || '',
      // Campos Fiado (null quando não é fiado)
      fiadoClienteId:   clienteFiado?.id   || null,
      fiadoClienteNome: clienteFiado?.nome || null,
      fiadoDividaId:    null, // preenchido abaixo após registrar a dívida
      _fiado:           formaPgto === 'Fiado',
      _fiadoClienteId:  clienteFiado?.id || null, // compatibilidade legada com fiado.html
    };

    // 1. Salva no Store
    Store.mutateVendas(v => { v.unshift(venda); });

    // 2. Sync Firebase
    if (window.CH.SyncQueue) {
      window.CH.SyncQueue.enqueue('salvar', 'vendas', [venda]);
    }

    // 3. Limpa carrinho imediatamente
    if (cart.clear) cart.clear();

    // ── FLUXO FIADO: registra dívida e encerra ────────────────────
    if (formaPgto === 'Fiado') {
      const dividaId = _registrarDividaFiado(venda, extras.fiadoClienteId);
      // Linka dívida ↔ venda
      Store.mutateVendas(list => {
        const v = list.find(v => v.id === venda.id);
        if (v) { v.fiadoDividaId = dividaId; venda.fiadoDividaId = dividaId; }
      });
      if (window.CH.SyncQueue) {
        window.CH.SyncQueue.enqueue('atualizar', 'vendas', [venda]);
      }
      EventBus.emit('fiado:divida_registrada', {
        vendaId:   venda.id,
        clienteId: extras.fiadoClienteId,
        valor:     total,
        operador:  venda.operador,
      });
      EventBus.emit('venda:finalizada', venda);
      return venda;
    }

    // ── REQUER APROVAÇÃO: para aqui, sem estoque/financeiro ──────
    if (requerAprovacao) {
      const ES = window.CH.EstoqueService;
      if (ES?.reservarEstoque) {
        try { ES.reservarEstoque(venda.id, venda.itens || []); }
        catch(e) { console.warn('[VendasService] Reserva de estoque falhou:', e.message); }
      }
      EventBus.emit('venda:pendente', venda);
      return venda;
    }

    // ── FLUXO DIRETO: dispara efeitos em background ───────────────
    _processarEfeitosAsync(venda).catch(e =>
      console.error('[VendasService] Erro em _processarEfeitosAsync:', e)
    );

    EventBus.emit('venda:finalizada', venda);
    return venda;
  }

  // ══════════════════════════════════════════════════════════════════
  //  CANCELAR VENDA
  // ══════════════════════════════════════════════════════════════════
  async function cancelarVenda(vendaId) {
    const venda = Store.getVendas().find(v => v.id === vendaId);
    if (!venda)                       throw new Error(`Venda ${vendaId} não encontrada`);
    if (venda.status === 'cancelada') throw new Error('Venda já cancelada');
    if (venda.status === 'pendente')  throw new Error('Use "rejeitar" no painel de aprovação');
    if (venda.status === 'rejeitada') throw new Error('Venda já foi rejeitada');

    // ── GUARDA FIADO: baixa só pelo módulo fiado.html ─────────────
    if (venda.formaPgto === 'Fiado' || venda._fiado) {
      throw new Error(
        'FIADO_BAIXA_BLOQUEADA: Esta venda é a prazo (Fiado). ' +
        'Para quitar ou cancelar, acesse o módulo Fiado.'
      );
    }

    if (['concluida', 'validada'].includes(venda.status)) {
      const EstoqueService = window.CH.EstoqueService;
      if (EstoqueService) await EstoqueService.cancelarVenda(vendaId, venda.itens || []);
    }

    Store.mutateVendas(vendas => {
      const v = vendas.find(v => v.id === vendaId);
      if (v) {
        v.status       = 'cancelada';
        v.canceladaEm  = Utils.nowISO();
        v.canceladaPor = AuthService.getNome();
      }
    });

    if (window.CH.SyncQueue) {
      const v = Store.getVendas().find(v => v.id === vendaId);
      if (v) window.CH.SyncQueue.enqueue('atualizar', 'vendas', [v]);
    }

    EventBus.emit('venda:cancelada', { vendaId, operador: AuthService.getNome() });
    return true;
  }

  // ══════════════════════════════════════════════════════════════════
  //  CONSULTAS
  // ══════════════════════════════════════════════════════════════════
  function getVendasPeriodo(dataDe, dataAte) {
    return Store.getVendas().filter(v => v.dataCurta >= dataDe && v.dataCurta <= dataAte);
  }

  function getVendasHoje() {
    return getVendasPeriodo(Utils.todayISO(), Utils.todayISO());
  }

  function getResumoHoje() {
    const todas  = getVendasHoje();
    const vendas = todas.filter(v => ['concluida', 'validada'].includes(v.status));
    const total  = vendas.reduce((s, v) => s + (v.total || 0), 0);
    const lucro  = vendas.reduce((s, v) => s + (v.lucro || 0), 0);
    const qtdItens = vendas.reduce((s, v) =>
      s + (v.itens?.reduce((si, i) => si + i.qtd, 0) || 0), 0);
    const porForma = {};
    vendas.forEach(v => {
      const f = v.formaPgto || 'Outros';
      porForma[f] = (porForma[f] || 0) + v.total;
    });
    return {
      quantidade: vendas.length, total, lucro, qtdItens,
      ticketMedio: vendas.length ? total / vendas.length : 0,
      porForma,
      pendentes: todas.filter(v => v.status === 'pendente').length,
      aprovadas: todas.filter(v => v.status === 'aprovada').length,
    };
  }

  function getResumoSemana() {
    const hoje = new Date(), dom = new Date(hoje);
    dom.setDate(hoje.getDate() - hoje.getDay());
    const vendas = getVendasPeriodo(dom.toISOString().slice(0, 10), Utils.todayISO())
      .filter(v => ['concluida', 'validada'].includes(v.status));
    return {
      quantidade: vendas.length,
      total:      vendas.reduce((s, v) => s + v.total, 0),
      lucro:      vendas.reduce((s, v) => s + (v.lucro || 0), 0),
    };
  }

  function getProdutosMaisVendidos(limite = 10, periodo = 30) {
    const dm = new Date();
    dm.setDate(dm.getDate() - periodo);
    const vendas = getVendasPeriodo(dm.toISOString().slice(0, 10), Utils.todayISO())
      .filter(v => ['concluida', 'validada'].includes(v.status));
    const mapa = {};
    vendas.forEach(venda => {
      venda.itens?.forEach(item => {
        if (!mapa[item.prodId]) {
          mapa[item.prodId] = { prodId: item.prodId, nome: item.nome, qtd: 0, total: 0 };
        }
        mapa[item.prodId].qtd   += item.qtd;
        mapa[item.prodId].total += item.preco * item.qtd;
      });
    });
    return Object.values(mapa).sort((a, b) => b.qtd - a.qtd).slice(0, limite);
  }

  // ══════════════════════════════════════════════════════════════════
  //  RELATÓRIO DETALHADO (v4.2) — para relatorios.html
  // ══════════════════════════════════════════════════════════════════
  function getVendasDetalhadas(filtro = 'dia', operadorId = null, formaPgto = null) {
    const hoje = new Date();
    const pad  = n => String(n).padStart(2, '0');
    const fmt  = d => `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}`;

    let de, ate, filtroHora = null;

    switch (filtro) {
      case 'hora': {
        const limite = new Date(hoje.getTime() - 60 * 60 * 1000);
        de = fmt(limite); ate = fmt(hoje);
        filtroHora = limite.toISOString();
        break;
      }
      case 'semana': {
        const dom = new Date(hoje);
        dom.setDate(hoje.getDate() - hoje.getDay());
        de = fmt(dom); ate = fmt(hoje);
        break;
      }
      case 'mes':
        de = `${hoje.getFullYear()}-${pad(hoje.getMonth()+1)}-01`;
        ate = fmt(hoje);
        break;
      case 'ano':
        de = `${hoje.getFullYear()}-01-01`;
        ate = fmt(hoje);
        break;
      default: // 'dia'
        de = fmt(hoje); ate = fmt(hoje);
    }

    let vendas = Store.getVendas().filter(v =>
      v.dataCurta >= de && v.dataCurta <= ate
    );
    if (filtroHora) {
      vendas = vendas.filter(v => (v.criadoEm || '') >= filtroHora);
    }
    if (operadorId) {
      vendas = vendas.filter(v =>
        v.operadorId === operadorId || v.operador === operadorId
      );
    }
    if (formaPgto) {
      vendas = vendas.filter(v => v.formaPgto === formaPgto);
    }

    return vendas
      .filter(v => ['concluida', 'validada'].includes(v.status))
      .map(v => ({
        id:           v.id,
        data:         v.data,
        hora:         v.hora,
        criadoEm:     v.criadoEm,
        operador:     v.operador,
        operadorId:   v.operadorId || v.operador,
        operadorRole: v.operadorRole || '—',
        itens:        v.itens || [],
        totalItens:   (v.itens||[]).reduce((s,i) => s + i.qtd, 0),
        total:        v.total,
        desconto:     v.desconto || 0,
        formaPgto:    v.formaPgto,
        statusPgto:   v.statusPgto || (v.formaPgto === 'Fiado' ? 'pendente_fiado' : 'pago'),
        fiadoCliente: v.fiadoClienteNome || null,
        origem:       v.origem || 'PDV',
      }));
  }

  window.CH.VendasService = {
    finalizarVenda,
    cancelarVenda,
    getVendasPeriodo,
    getVendasHoje,
    getResumoHoje,
    getResumoSemana,
    getProdutosMaisVendidos,
    getVendasDetalhadas,
  };

})();

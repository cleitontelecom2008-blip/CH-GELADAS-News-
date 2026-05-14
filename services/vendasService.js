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

    // Financeiro — registrado automaticamente pelo FinanceiroService
    // via EventBus.on('venda:finalizada') — NÃO chamar diretamente aqui
    // para evitar duplo lançamento no Store.getFinanceiro().
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

    const lucro = itens.reduce((s, i) => s + (i.preco - (i.custo || 0)) * i.qtd, 0) - desconto;
    const role  = AuthService.getRole();

    // ── Decisão de aprovação (100% síncrona) ──────────────────────
    const _Perm = window.CH.PermissoesService;
    const _rolesLivres = ['adm', 'admin', 'gerente', 'operador', 'pdv', 'entregador'];
    let requerAprovacao;
    if (_Perm) {
      requerAprovacao = _Perm.getFlag(role, 'vendas_requer_aprovacao');
    } else {
      // Fallback conservador: qualquer role fora da lista livre requer aprovação
      requerAprovacao = !_rolesLivres.includes(role);
      console.warn('[VendasService] PermissoesService não carregado — usando fallback conservador para role:', role);
    }

    const venda = {
      id:               Utils.generateId(),
      dataCurta:        Utils.todayISO(),
      data:             Utils.today(),
      hora:             Utils.nowTime(),
      criadoEm:         Utils.nowISO(),
      itens, total, subtotal, desconto, lucro,
      formaPgto:        formaPgto || 'Dinheiro',
      origem:           'PDV',
      operador:         AuthService.getNome(),
      role,
      status:           requerAprovacao ? 'pendente' : 'concluida',
      _fbSynced:        false,
      _troco:           extras.troco           || 0,
      _parcelaDinheiro: extras.parcelaDinheiro || 0,
      _parcelaRestante: extras.parcelaRestante || 0,
      // ── Contexto multi-filial / SaaS ───────────────────────────
      filialId:   window.CH?.FilialService?.getFilialId?.()   || 'principal',
      empresaId:  window.CH?.SaasService?.getEmpresaId?.()    || null,
      _formaRestante:   extras.formaRestante   || '',
    };

    // 1. Salva no Store
    Store.mutateVendas(v => { v.unshift(venda); });

    // 2. Sync Firebase
    if (window.CH.SyncQueue) {
      window.CH.SyncQueue.enqueue('salvar', 'vendas', [venda]);
    }

    // 3. Limpa carrinho imediatamente
    if (cart.clear) cart.clear();

    // ── REQUER APROVAÇÃO: para aqui, sem estoque/financeiro ──────
    if (requerAprovacao) {
      EventBus.emit('venda:pendente', venda);
      console.info(`[VendasService] Venda PENDENTE (${role}) → ${venda.id} | aguarda controlador`);
      return venda; // ← retorna objeto real, não Promise
    }

    // ── FLUXO DIRETO: dispara efeitos em background ───────────────
    _processarEfeitosAsync(venda).catch(e =>
      console.error('[VendasService] Erro em _processarEfeitosAsync:', e)
    );

    EventBus.emit('venda:finalizada', venda);
    return venda; // ← retorna objeto real, não Promise
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

    if (['concluida', 'validada'].includes(venda.status)) {
      const FinanceiroService = window.CH.FinanceiroService;
      if (FinanceiroService) FinanceiroService.registrarEstorno(venda);
    }

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

  window.CH.VendasService = {
    finalizarVenda,
    cancelarVenda,
    getVendasPeriodo,
    getVendasHoje,
    getResumoHoje,
    getResumoSemana,
    getProdutosMaisVendidos,
  };

  console.info('%c VendasService ✓  (síncrono | aprovação via PermissoesService)', 'color:#10b981;font-weight:bold');
})();

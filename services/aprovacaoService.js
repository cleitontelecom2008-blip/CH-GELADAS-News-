'use strict';
/**
 * services/aprovacaoService.js — CH Geladas PDV
 * ─────────────────────────────────────────────────────────────
 * AUDITORIA FINAL — Correções críticas de produção:
 *
 * [DUPLO CLIQUE] _idsEmValidacao (Set) impede que validarVenda seja
 *   executado concorrentemente para o mesmo ID. Se o Validador clicar
 *   duas vezes antes da primeira execução terminar, a segunda chamada
 *   retorna false imediatamente sem alterar estoque ou financeiro.
 *
 * [ESTADO] Verificação de status (=== 'aprovada') ocorre DENTRO do
 *   lock — atômico em relação a qualquer outra mutação do Store.
 *
 * [LOGS] Todos os warn/error incluem timestamp UTC ISO e contexto.
 *
 * Fluxo: pendente → (controlador) → aprovada → (validador) → validada
 */

(function () {
  const { Store, AuthService, Utils, EventBus } = window.CH;

  // Flag de lote — impede re-renders entre itens de validarTodas/aprovarTodas
  let _processandoLote = false;

  // Guard atômico por ID para validarVenda individual
  // Impede duplo clique, chamada concorrente ou retry acidental
  const _idsEmValidacao = new Set();

  function _perm(modulo) {
    const role = AuthService.getRole();
    if (['adm', 'admin'].includes(role)) return true;
    return window.CH.PermissoesService
      ? window.CH.PermissoesService.temAcesso(role, modulo)
      : false;
  }

  function _sync(vendaId) {
    if (!window.CH.SyncQueue) return;
    const v = Store.getVendas().find(v => v.id === vendaId);
    if (v) window.CH.SyncQueue.enqueue('atualizar', 'vendas', [v]);
  }

  function _syncLote(vendaIds) {
    if (!window.CH.SyncQueue || !vendaIds.length) return;
    const todas = Store.getVendas();
    const lote  = vendaIds.map(id => todas.find(v => v.id === id)).filter(Boolean);
    if (lote.length) window.CH.SyncQueue.enqueue('atualizar', 'vendas', lote);
  }

  // ── Queries ───────────────────────────────────────────────────────
  function getPendentes() {
    return Store.getVendas()
      .filter(v => v.status === 'pendente')
      .sort((a, b) => (b.criadoEm || '').localeCompare(a.criadoEm || ''));
  }
  function getAprovadas() {
    return Store.getVendas()
      .filter(v => v.status === 'aprovada')
      .sort((a, b) => (b.aprovadaEm || '').localeCompare(a.aprovadaEm || ''));
  }
  function getRejeitadas() {
    return Store.getVendas()
      .filter(v => v.status === 'rejeitada')
      .sort((a, b) => (b.rejeitadaEm || '').localeCompare(a.rejeitadaEm || ''));
  }
  function getValidadas() {
    return Store.getVendas()
      .filter(v => v.status === 'validada')
      .sort((a, b) => (b.validadaEm || '').localeCompare(a.validadaEm || ''));
  }
  function contarPendentes() { return getPendentes().length; }
  function contarAprovadas() { return getAprovadas().length; }

  // ── APROVAR individual (pendente → aprovada) ──────────────────────
  function aprovarVenda(vendaId) {
    if (!_perm('aprovacao_controle'))
      throw new Error('Sem permissão para aprovar vendas');

    const venda = Store.getVendas().find(v => v.id === vendaId);
    if (!venda) throw new Error(`Venda ${vendaId} não encontrada`);
    if (venda.status !== 'pendente')
      throw new Error(`Venda está "${venda.status}", esperado "pendente"`);

    const EstoqueService = window.CH.EstoqueService;
    if (EstoqueService) {
      const reservas = EstoqueService.getReservas();
      for (const item of venda.itens || []) {
        const prod = EstoqueService.getProduto(item.prodId);
        if (!prod) continue;
        const pack  = prod.packs?.find(pk => pk.label === item.label || (pk.qtd + 'x') === item.label);
        const qtdUn = item.label === 'UNID' ? item.qtd : item.qtd * (pack?.qtd || 1);
        const reservaOutros = Object.entries(reservas)
          .filter(([vid]) => vid !== vendaId)
          .reduce((s, [, r]) => s + (r[item.prodId] || 0), 0);
        const disponivel = Math.max(0, (prod.estoqueAtual ?? 0) - reservaOutros);
        if (disponivel < qtdUn) {
          throw new Error(
            `Estoque insuficiente para "${prod.nome}": ` +
            `disponível ${disponivel} (${prod.estoqueAtual} físico − ${reservaOutros} reservados), ` +
            `necessário ${qtdUn}`
          );
        }
      }
    }

    Store.mutateVendas(list => {
      const v = list.find(v => v.id === vendaId);
      if (v) {
        v.status      = 'aprovada';
        v.aprovadaEm  = Utils.nowISO();
        v.aprovadaPor = AuthService.getNome();
      }
    });

    _sync(vendaId);
    EventBus.emit('venda:aprovada', { vendaId, operador: AuthService.getNome() });
    return true;
  }

  // ── REJEITAR (pendente|aprovada → rejeitada) ──────────────────────
  function rejeitarVenda(vendaId, motivo = '') {
    const podeC = _perm('aprovacao_controle');
    const podeV = _perm('aprovacao_validacao');
    if (!podeC && !podeV) throw new Error('Sem permissão para rejeitar vendas');

    const venda = Store.getVendas().find(v => v.id === vendaId);
    if (!venda) throw new Error(`Venda ${vendaId} não encontrada`);
    if (!['pendente', 'aprovada'].includes(venda.status))
      throw new Error(`Venda "${venda.status}" não pode ser rejeitada`);

    Store.mutateVendas(list => {
      const v = list.find(v => v.id === vendaId);
      if (v) {
        v.status         = 'rejeitada';
        v.rejeitadaEm    = Utils.nowISO();
        v.rejeitadaPor   = AuthService.getNome();
        v.motivoRejeicao = motivo;
      }
    });

    window.CH.EstoqueService?.liberarReserva?.(vendaId);

    _sync(vendaId);
    EventBus.emit('venda:rejeitada', { vendaId, motivo, operador: AuthService.getNome() });
    return true;
  }

  // ── VALIDAR individual (aprovada → validada) ──────────────────────
  // GUARD ATÔMICO: _idsEmValidacao impede execução concorrente para o mesmo ID.
  // Cenário de duplo clique: segunda chamada retorna false antes de qualquer mutação.
  async function validarVenda(vendaId) {
    if (!_perm('aprovacao_validacao'))
      throw new Error('Sem permissão para validar vendas');

    // ── LOCK por ID ──────────────────────────────────────────────
    if (_idsEmValidacao.has(vendaId)) {
      console.warn(
        `[AprovacaoService] validarVenda ignorado — já em processamento | ts=${new Date().toISOString()} | vendaId=${vendaId}`
      );
      return false;
    }
    _idsEmValidacao.add(vendaId);

    try {
      // Relê o estado APÓS adquirir o lock para garantir consistência
      const venda = Store.getVendas().find(v => v.id === vendaId);
      if (!venda) throw new Error(`Venda ${vendaId} não encontrada`);

      // Verificação de status DENTRO do lock — estado definitivo neste ponto
      if (venda.status !== 'aprovada') {
        console.warn(
          `[AprovacaoService] validarVenda abortado — status inválido | ts=${new Date().toISOString()} | vendaId=${vendaId} | status=${venda.status}`
        );
        return false;
      }

      // 1. Persiste status 'validada' localmente (atômico — síncrono)
      Store.mutateVendas(list => {
        const v = list.find(v => v.id === vendaId);
        if (v) {
          v.status      = 'validada';
          v.validadaEm  = Utils.nowISO();
          v.validadaPor = AuthService.getNome();
        }
      });

      // 2. Libera reserva de estoque
      window.CH.EstoqueService?.liberarReserva?.(vendaId);

      // 3. Sincroniza com Firebase (fire-and-forget — falha de rede não bloqueia)
      if (!_processandoLote) _sync(vendaId);

      // 4. Baixa estoque — falha por item não aborta a validação
      const EstoqueService = window.CH.EstoqueService;
      if (EstoqueService) {
        for (const item of venda.itens || []) {
          try {
            const prod  = EstoqueService.getProduto(item.prodId);
            const pack  = prod?.packs?.find(pk =>
              pk.label === item.label || (pk.qtd + 'x') === item.label
            );
            const qtdUn = item.label === 'UNID' ? item.qtd : item.qtd * (pack?.qtd || 1);
            await EstoqueService.baixarEstoqueVenda(item.prodId, qtdUn, venda.id);
          } catch (e) {
            console.warn(
              `[AprovacaoService] Estoque falhou | ts=${new Date().toISOString()} | item="${item.nome}" | vendaId=${vendaId} | erro=${e.message}`
            );
          }
        }
      } else {
        Store.mutateEstoque(estoque => {
          (venda.itens || []).forEach(item => {
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

      // 5. Dispara fluxo financeiro via EventBus
      // financeiroService.js ouve 'venda:finalizada' e registrarReceita tem guard idempotente
      if (!_processandoLote) {
        EventBus.emit('venda:finalizada', venda);
        EventBus.emit('venda:validada', venda);
      }

      return true;

    } catch (e) {
      console.error(
        `[AprovacaoService] validarVenda falhou | ts=${new Date().toISOString()} | vendaId=${vendaId} | erro=${e.message}`
      );
      // Notifica o usuário sobre a falha
      try {
        window.CH?.UIService?.showToast('Erro ao validar venda', e.message, 'error');
      } catch (_) {}
      throw e;

    } finally {
      // SEMPRE libera o lock — mesmo em caso de exceção
      _idsEmValidacao.delete(vendaId);
    }
  }

  // ── APROVAR EM LOTE ───────────────────────────────────────────────
  function aprovarTodas() {
    if (!_perm('aprovacao_controle'))
      throw new Error('Sem permissão para aprovar vendas');

    const pendentes = getPendentes();
    if (!pendentes.length) return { total: 0, erros: [] };

    const agora    = Utils.nowISO();
    const operador = AuthService.getNome();
    const ids      = pendentes.map(v => v.id);
    const erros    = [];

    _processandoLote = true;
    try {
      Store.mutateVendas(list => {
        ids.forEach(id => {
          const v = list.find(v => v.id === id);
          if (v && v.status === 'pendente') {
            v.status      = 'aprovada';
            v.aprovadaEm  = agora;
            v.aprovadaPor = operador;
          }
        });
      });

      _syncLote(ids);
      EventBus.emit('venda:aprovada:lote', { total: ids.length, operador });

    } catch (e) {
      erros.push({ erro: e.message });
      console.error(
        `[AprovacaoService] aprovarTodas falhou | ts=${new Date().toISOString()} | erro=${e.message}`
      );
    } finally {
      _processandoLote = false;
    }

    return { total: pendentes.length, erros };
  }

  // ── VALIDAR EM LOTE ───────────────────────────────────────────────
  async function validarTodas() {
    if (!_perm('aprovacao_validacao'))
      throw new Error('Sem permissão para validar vendas');

    const aprovadas = getAprovadas();
    if (!aprovadas.length) return { total: 0, erros: [] };

    const agora    = Utils.nowISO();
    const operador = AuthService.getNome();
    const ids      = aprovadas.map(v => v.id);
    const erros    = [];

    _processandoLote = true;
    try {
      // Passo 1: muda todos os status de uma vez (mutação única = zero re-renders intermediários)
      Store.mutateVendas(list => {
        ids.forEach(id => {
          const v = list.find(v => v.id === id);
          if (v && v.status === 'aprovada') {
            v.status      = 'validada';
            v.validadaEm  = agora;
            v.validadaPor = operador;
          }
        });
      });

      // Passo 2: sync único para todo o lote
      _syncLote(ids);

      // Passo 3: libera reservas de estoque
      const ES = window.CH.EstoqueService;
      if (ES?.liberarReserva) ids.forEach(id => ES.liberarReserva(id));

      // Passo 4: efeitos colaterais (estoque) por item
      for (const venda of aprovadas) {
        try {
          if (ES) {
            for (const item of venda.itens || []) {
              try {
                const prod  = ES.getProduto(item.prodId);
                const pack  = prod?.packs?.find(pk =>
                  pk.label === item.label || (pk.qtd + 'x') === item.label
                );
                const qtdUn = item.label === 'UNID'
                  ? item.qtd
                  : item.qtd * (pack?.qtd || 1);
                await ES.baixarEstoqueVenda(item.prodId, qtdUn, venda.id);
              } catch (e) {
                console.warn(
                  `[AprovacaoService] Lote estoque falhou | ts=${new Date().toISOString()} | item="${item.nome}" | vendaId=${venda.id} | erro=${e.message}`
                );
              }
            }
          } else {
            Store.mutateEstoque(estoque => {
              (venda.itens || []).forEach(item => {
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
        } catch (e) {
          erros.push({ id: venda.id, erro: e.message });
          console.error(
            `[AprovacaoService] Lote item falhou | ts=${new Date().toISOString()} | vendaId=${venda.id} | erro=${e.message}`
          );
        }
      }

      // Passo 5: evento único — UI re-renderiza uma vez, financeiro processa o lote
      // registrarReceita tem guard idempotente — seguro emitir mesmo em retry
      EventBus.emit('venda:validada:lote', { total: ids.length, operador });
      EventBus.emit('venda:finalizada:lote', aprovadas);

    } catch (e) {
      console.error(
        `[AprovacaoService] validarTodas falhou | ts=${new Date().toISOString()} | erro=${e.message}`
      );
      try {
        window.CH?.UIService?.showToast('Erro na validação em lote', e.message, 'error');
      } catch (_) {}
    } finally {
      _processandoLote = false;
    }

    return { total: aprovadas.length, erros };
  }

  window.CH.AprovacaoService = {
    getPendentes, getAprovadas, getRejeitadas, getValidadas,
    contarPendentes, contarAprovadas,
    aprovarVenda, rejeitarVenda, validarVenda,
    aprovarTodas, validarTodas,
    isProcessandoLote: () => _processandoLote,
  };

})();

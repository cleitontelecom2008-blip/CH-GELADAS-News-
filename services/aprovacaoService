'use strict';
/**
 * services/aprovacaoService.js — CH Geladas PDV
 * Fluxo:  pendente → (controlador) → aprovada → (validador) → validada
 * Permissões lidas dinamicamente do PermissoesService.
 * validarVenda() é async mas não bloqueia a UI.
 */

(function () {
  const { Store, AuthService, Utils, EventBus } = window.CH;

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

  // ── APROVAR (pendente → aprovada) ─────────────────────────────────
  function aprovarVenda(vendaId) {
    if (!_perm('aprovacao_controle'))
      throw new Error('Sem permissão para aprovar vendas');

    const venda = Store.getVendas().find(v => v.id === vendaId);
    if (!venda) throw new Error('Venda não encontrada');
    if (venda.status !== 'pendente')
      throw new Error(`Venda está "${venda.status}", esperado "pendente"`);

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
    if (!venda) throw new Error('Venda não encontrada');
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

    _sync(vendaId);
    EventBus.emit('venda:rejeitada', { vendaId, motivo, operador: AuthService.getNome() });
    return true;
  }

  // ── VALIDAR (aprovada → validada) — aciona estoque + financeiro ───
  async function validarVenda(vendaId) {
    if (!_perm('aprovacao_validacao'))
      throw new Error('Sem permissão para validar vendas');

    const venda = Store.getVendas().find(v => v.id === vendaId);
    if (!venda) throw new Error('Venda não encontrada');
    if (venda.status !== 'aprovada')
      throw new Error(`Venda está "${venda.status}", esperado "aprovada"`);

    // 1. Marca como validada ANTES dos efeitos (idempotente)
    Store.mutateVendas(list => {
      const v = list.find(v => v.id === vendaId);
      if (v) {
        v.status     = 'validada';
        v.validadaEm = Utils.nowISO();
        v.validadaPor = AuthService.getNome();
      }
    });

    _sync(vendaId);

    // 2. Baixa estoque
    const EstoqueService = window.CH.EstoqueService;
    if (EstoqueService) {
      for (const item of venda.itens || []) {
        try {
          const prod  = EstoqueService.getProduto(item.prodId);
          const pack  = prod?.packs?.find(pk =>
            pk.label === item.label || (pk.qtd + 'x') === item.label
          );
          const qtdUn = item.label === 'UNID'
            ? item.qtd
            : item.qtd * (pack?.qtd || 1);
          await EstoqueService.baixarEstoqueVenda(item.prodId, qtdUn, venda.id);
        } catch (e) {
          console.warn(`[AprovacaoService] Estoque falhou "${item.nome}":`, e.message);
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

    // 3. Registra no financeiro
    const FinanceiroService = window.CH.FinanceiroService;
    if (FinanceiroService) FinanceiroService.registrarReceita(venda);

    // 4. Emite evento — Telegram, Audit, etc. ouvem
    EventBus.emit('venda:finalizada', venda);
    EventBus.emit('venda:validada', venda);
    return true;
  }

  // ── Ações em lote ─────────────────────────────────────────────────
  function aprovarTodas() {
    const pendentes = getPendentes();
    const erros = [];
    pendentes.forEach(v => {
      try { aprovarVenda(v.id); }
      catch (e) { erros.push({ id: v.id, erro: e.message }); }
    });
    return { total: pendentes.length, erros };
  }

  async function validarTodas() {
    const aprovadas = getAprovadas();
    const erros = [];
    for (const v of aprovadas) {
      try { await validarVenda(v.id); }
      catch (e) { erros.push({ id: v.id, erro: e.message }); }
    }
    return { total: aprovadas.length, erros };
  }

  window.CH.AprovacaoService = {
    getPendentes, getAprovadas, getRejeitadas, getValidadas,
    contarPendentes, contarAprovadas,
    aprovarVenda, rejeitarVenda, validarVenda,
    aprovarTodas, validarTodas,
  };

  console.info('%c AprovacaoService ✓  (pendente→aprovada→validada | permissões dinâmicas)', 'color:#f59e0b;font-weight:bold');
})();

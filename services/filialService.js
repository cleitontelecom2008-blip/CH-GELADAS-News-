'use strict';
/**
 * services/filialService.js — CH Geladas PDV
 * ─────────────────────────────────────────────────────────────
 * Gerenciamento multi-filial: cada filial tem seus próprios dados
 * isolados no Firestore em saas_dados/{empresaId}/filiais/{filialId}
 *
 * MODELO DE DADOS:
 *
 *   Filial: {
 *     id, empresaId, nome, endereco, telefone, ativa,
 *     criadoEm, config (alertaEstoque, telegram, etc.)
 *   }
 *
 * ISOLAMENTO NO FIRESTORE:
 *   Cada filial tem seu próprio sub-path:
 *   saas_dados/{empresaId}/filiais/{filialId}/estoque/{prodId}
 *   saas_dados/{empresaId}/filiais/{filialId}/vendas/{vendaId}
 *   ...etc
 *
 * MODO STANDALONE (sem SaaS):
 *   filialId = 'principal' fixo — comportamento atual inalterado.
 *
 * USO:
 *   CH.FilialService.getFilialAtual()         → { id, nome, ... }
 *   CH.FilialService.setFilialAtiva(filialId) → troca de filial
 *   CH.FilialService.listar()                 → todas da empresa
 *   CH.FilialService.criar({ nome, ... })     → nova filial
 *   CH.FilialService.getPathCol(col)          → path Firestore para collection
 *
 * INTEGRAÇÃO COM FIREBASESERVICE:
 *   FirebaseService.salvar/ler usam getPathCol internamente quando
 *   filialService está ativo.
 *
 * Requer: core.js + saasService.js carregados antes.
 */

(function () {
  const { Store, Utils, EventBus } = window.CH;

  // ── Chave de sessão ──────────────────────────────────────────────
  const SESS_KEY = 'CH_FILIAL_ID';

  function _getEmpresaId() {
    // Do SaasService (modo SaaS)
    const SaaS = window.CH?.SaasService;
    if (SaaS?.getEmpresaId) return SaaS.getEmpresaId();
    // Do Store config (modo legado)
    return Store.getConfig()?.empresaId || 'default';
  }

  function getFilialId() {
    return sessionStorage.getItem(SESS_KEY) || localStorage.getItem(SESS_KEY) || 'principal';
  }

  function _setFilialId(id) {
    sessionStorage.setItem(SESS_KEY, id);
    localStorage.setItem(SESS_KEY, id);
  }

  // ── Path de coleção no Firestore ─────────────────────────────────
  /**
   * Retorna o path correto para uma coleção de acordo com o contexto:
   *   - Modo SaaS multi-filial: saas_dados/{empresaId}/filiais/{filialId}/{col}
   *   - Modo SaaS uma filial:   saas_dados/{empresaId}/{col}
   *   - Modo standalone:        ch_dados/{col}  (legacy)
   */
  function getPathCol(colecao) {
    const empresaId = _getEmpresaId();
    const filialId  = getFilialId();
    const FF        = window.CH?.FeatureFlags;

    if (!FF || FF.planoAtual() === '_standalone') {
      return `ch_dados`; // modo legado
    }
    if (FF.pode('multi_filial') && filialId !== 'principal') {
      return `saas_dados/${empresaId}/filiais/${filialId}`;
    }
    return `saas_dados/${empresaId}`;
  }

  /** Path para um documento específico */
  function getPathDoc(colecao, docId) {
    return `${getPathCol(colecao)}/${colecao}/${docId}`;
  }

  // ── CRUD de filiais ──────────────────────────────────────────────

  async function _ensureDB() {
    const FB = window.CH?.FirebaseService;
    if (!FB) throw new Error('FirebaseService não disponível');
    if (!FB.isReady()) await FB.init();
    return FB;
  }

  async function listar() {
    const empresaId = _getEmpresaId();
    if (!empresaId || empresaId === 'default') {
      return [{ id: 'principal', nome: 'Principal', ativa: true }];
    }
    try {
      const FB = await _ensureDB();
      const snap = await FB.ler(`saas_filiais_${empresaId}`);
      if (snap && Array.isArray(snap)) return snap;
    } catch (_) {}
    return [{ id: 'principal', nome: 'Principal', ativa: true }];
  }

  async function criar({ nome, endereco = '', telefone = '', config = {} }) {
    if (!nome?.trim()) throw new Error('Nome da filial é obrigatório');
    const FF = window.CH?.FeatureFlags;
    if (FF && !FF.pode('multi_filial')) {
      FF.exigir('multi_filial');
      throw new Error('Multi-filial disponível apenas no plano Enterprise');
    }

    const empresaId = _getEmpresaId();
    if (!empresaId || empresaId === 'default') throw new Error('Empresa não identificada');

    const filial = {
      id:         Utils.generateId().slice(0, 8),
      empresaId,
      nome:       nome.trim(),
      endereco:   endereco.trim(),
      telefone:   telefone.trim(),
      ativa:      true,
      config,
      criadoEm:   Utils.nowISO(),
    };

    const FB = await _ensureDB();
    const lista = await listar();
    lista.push(filial);
    await FB.salvar(`saas_filiais_${empresaId}`, lista);

    EventBus.emit('filial:criada', filial);
    return filial;
  }

  async function atualizar(filialId, campos) {
    const empresaId = _getEmpresaId();
    const FB        = await _ensureDB();
    const lista     = await listar();
    const idx       = lista.findIndex(f => f.id === filialId);
    if (idx < 0) throw new Error(`Filial ${filialId} não encontrada`);
    lista[idx] = { ...lista[idx], ...campos, updatedAt: Utils.nowISO() };
    await FB.salvar(`saas_filiais_${empresaId}`, lista);
    EventBus.emit('filial:atualizada', lista[idx]);
    return lista[idx];
  }

  async function desativar(filialId) {
    return atualizar(filialId, { ativa: false });
  }

  // ── Troca de filial ativa ────────────────────────────────────────
  async function setFilialAtiva(filialId) {
    const lista = await listar();
    const filial = lista.find(f => f.id === filialId);
    if (!filial) throw new Error(`Filial ${filialId} não encontrada`);
    if (!filial.ativa) throw new Error(`Filial "${filial.nome}" está inativa`);

    const anterior = getFilialId();
    _setFilialId(filialId);

    // Aplica config da filial (alertas, telegram, etc.)
    if (filial.config && Object.keys(filial.config).length) {
      Store.mutateConfig(cfg => Object.assign(cfg, filial.config));
    }

    // Aplica white-label da filial se tiver
    if (filial.branding) {
      window.CH?.WhitelabelService?.aplicar(filial.branding);
    }

    // Força re-hidratação dos dados da nova filial
    await Store.hydrateAsync(['estoque', 'vendas', 'config']);

    EventBus.emit('filial:trocada', { de: anterior, para: filialId, filial });
    window.CH?.UIService?.showToast?.('Filial alterada', filial.nome, 'info');
    return filial;
  }

  // ── Filial atual ─────────────────────────────────────────────────
  async function getFilialAtual() {
    const id    = getFilialId();
    const lista = await listar();
    return lista.find(f => f.id === id) || { id: 'principal', nome: 'Principal', ativa: true };
  }

  function getFilialAtualSync() {
    const id  = getFilialId();
    const cfg = Store.getConfig()?.filiais || [];
    return cfg.find(f => f.id === id) || { id, nome: id === 'principal' ? 'Principal' : id, ativa: true };
  }

  // ── Relatório consolidado multi-filial ───────────────────────────
  async function getResumoConsolidado(dataDe, dataAte) {
    const FF = window.CH?.FeatureFlags;
    if (!FF?.pode('multi_filial')) return null;

    const lista = await listar();
    const ativas = lista.filter(f => f.ativa);
    const resumos = [];

    for (const filial of ativas) {
      try {
        const filialIdOrig = getFilialId();
        _setFilialId(filial.id);
        await Store.hydrateAsync(['vendas']);
        const vendas = Store.getVendas().filter(v =>
          ['concluida','validada'].includes(v.status) &&
          (!dataDe || v.dataCurta >= dataDe) &&
          (!dataAte || v.dataCurta <= dataAte)
        );
        const receita = vendas.reduce((s,v) => s + (v.total||0), 0);
        const lucro   = vendas.reduce((s,v) => s + (v.lucro||0), 0);
        resumos.push({ filial: filial.nome, filialId: filial.id, vendas: vendas.length, receita, lucro });
        _setFilialId(filialIdOrig); // restaura
      } catch (_) {}
    }

    return resumos;
  }

  // ── Exportar ─────────────────────────────────────────────────────
  window.CH.FilialService = {
    getFilialId,
    getFilialAtual,
    getFilialAtualSync,
    setFilialAtiva,
    listar,
    criar,
    atualizar,
    desativar,
    getPathCol,
    getPathDoc,
    getResumoConsolidado,
  };

  console.info('%c FilialService ✓  (multi-filial | path isolation | consolidado)', 'color:#10b981;font-weight:bold');
})();

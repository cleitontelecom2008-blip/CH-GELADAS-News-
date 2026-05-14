'use strict';
/**
 * services/permissoesService.js — CH Geladas PDV
 * Perfis e permissões salvos no Firebase Firestore (ch_perfis)
 * + cache local no localStorage.
 * Nunca se perdem ao limpar histórico do browser.
 */

(function () {
  const STORAGE_KEY = 'CH_PERFIS';
  const FB_DOC      = 'ch_perfis';

  const MODULOS = [
    { id: 'vendas',              label: 'Vendas (PDV)',           icone: '🛒', cor: '#3b82f6' },
    { id: 'estoque',             label: 'Estoque',                icone: '📦', cor: '#10b981' },
    { id: 'financeiro',          label: 'Financeiro',             icone: '📊', cor: '#8b5cf6' },
    { id: 'fiado',               label: 'Fiado',                  icone: '🤝', cor: '#ef4444' },
    { id: 'comandas',            label: 'Comandas',               icone: '🍽️', cor: '#ec4899' },
    { id: 'delivery',            label: 'Delivery',               icone: '🛵', cor: '#f97316' },
    { id: 'ponto',               label: 'Ponto',                  icone: '⏱️', cor: '#14b8a6' },
    { id: 'cardapio',            label: 'Cardápio Digital',       icone: '📋', cor: '#f97316' },
    { id: 'aprovacao_controle',  label: 'Aprovação — Controle',  icone: '🔍', cor: '#f59e0b' },
    { id: 'aprovacao_validacao', label: 'Aprovação — Validação', icone: '✅', cor: '#8b5cf6' },
    { id: 'relatorios',          label: 'Relatórios',             icone: '📈', cor: '#64748b' },
  ];

  const FLAGS = [
    { id: 'vendas_requer_aprovacao', label: 'Vendas entram como Pendente (requerem aprovação)' },
  ];

  const PERFIS_PADRAO = {
    colaborador: {
      label: 'Colaborador', cor: '#3b82f6', icone: '🛒',
      modulos: { vendas:2, estoque:0, financeiro:0, fiado:0, comandas:0, delivery:0, ponto:1, cardapio:0, aprovacao_controle:0, aprovacao_validacao:0, relatorios:0 },
      flags: { vendas_requer_aprovacao: true },
    },
    controlador: {
      label: 'Controlador', cor: '#f59e0b', icone: '🔍',
      modulos: { vendas:1, estoque:0, financeiro:0, fiado:0, comandas:0, delivery:0, ponto:1, cardapio:0, aprovacao_controle:2, aprovacao_validacao:0, relatorios:1 },
      flags: { vendas_requer_aprovacao: false },
    },
    validador: {
      label: 'Validador', cor: '#8b5cf6', icone: '✅',
      modulos: { vendas:1, estoque:1, financeiro:1, fiado:0, comandas:0, delivery:0, ponto:1, cardapio:0, aprovacao_controle:0, aprovacao_validacao:2, relatorios:1 },
      flags: { vendas_requer_aprovacao: false },
    },
    analista: {
      label: 'Analista', cor: '#8b5cf6', icone: '📋',
      modulos: { vendas:1, estoque:1, financeiro:1, fiado:0, comandas:0, delivery:0, ponto:1, cardapio:0, aprovacao_controle:0, aprovacao_validacao:2, relatorios:1 },
      flags: { vendas_requer_aprovacao: false },
    },
    gerente: {
      label: 'Gerente', cor: '#f59e0b', icone: '📊',
      modulos: { vendas:2, estoque:2, financeiro:2, fiado:2, comandas:2, delivery:2, ponto:2, cardapio:1, aprovacao_controle:0, aprovacao_validacao:0, relatorios:2 },
      flags: { vendas_requer_aprovacao: false },
    },
    operador: {
      label: 'Operador', cor: '#10b981', icone: '🖥️',
      modulos: { vendas:2, estoque:1, financeiro:0, fiado:0, comandas:2, delivery:2, ponto:1, cardapio:0, aprovacao_controle:0, aprovacao_validacao:0, relatorios:0 },
      flags: { vendas_requer_aprovacao: false },
    },
    entregador: {
      label: 'Entregador', cor: '#06b6d4', icone: '🚴',
      modulos: { vendas:0, estoque:0, financeiro:0, fiado:0, comandas:0, delivery:2, ponto:1, cardapio:0, aprovacao_controle:0, aprovacao_validacao:0, relatorios:0 },
      flags: { vendas_requer_aprovacao: false },
    },
  };

  const ADM_MODULOS = {};
  MODULOS.forEach(m => { ADM_MODULOS[m.id] = 2; });

  // ── localStorage ─────────────────────────────────────────────────
  function _load() {
    try { const r = localStorage.getItem(STORAGE_KEY); return r ? JSON.parse(r) : null; } catch { return null; }
  }
  function _save(perfis) {
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(perfis)); } catch(e) {}
  }

  // ── Firebase ──────────────────────────────────────────────────────
  async function _saveFirebase(perfis) {
    try {
      const FS = window.CH.FirebaseService;
      if (!FS || !FS.isReady?.()) return;
      await FS.salvar(FB_DOC, perfis);
    } catch(e) { console.warn('[PermissoesService] Firebase salvar falhou:', e.message); }
  }

  async function _loadFirebase() {
    try {
      const FS = window.CH.FirebaseService;
      if (!FS || !FS.isReady?.()) return null;
      const data = await FS.ler(FB_DOC);
      return (data && typeof data === 'object' && !Array.isArray(data)) ? data : null;
    } catch(e) { console.warn('[PermissoesService] Firebase ler falhou:', e.message); return null; }
  }

  // ── Inicialização com migração ────────────────────────────────────
  async function inicializar() {
    const local = _load();

    // Se não tem local, tenta Firebase primeiro
    if (!local) {
      const remoto = await _loadFirebase();
      if (remoto && Object.keys(remoto).length > 0) {
        _save(remoto);
        console.info('[PermissoesService] Perfis restaurados do Firebase.');
        return;
      }
      // Sem remoto: grava padrões
      const padrao = JSON.parse(JSON.stringify(PERFIS_PADRAO));
      _save(padrao);
      await _saveFirebase(padrao);
      return;
    }

    // Tem local: migra campos ausentes
    let changed = false;
    const merged = { ...local };
    Object.entries(PERFIS_PADRAO).forEach(([id, padrao]) => {
      if (!merged[id]) {
        merged[id] = JSON.parse(JSON.stringify(padrao));
        changed = true;
        return;
      }
      if (!merged[id].flags) {
        merged[id].flags = JSON.parse(JSON.stringify(padrao.flags));
        changed = true;
      } else {
        FLAGS.forEach(f => {
          if (merged[id].flags[f.id] === undefined) {
            merged[id].flags[f.id] = padrao.flags?.[f.id] ?? false;
            changed = true;
          }
        });
      }
      MODULOS.forEach(m => {
        if (merged[id].modulos && merged[id].modulos[m.id] === undefined) {
          merged[id].modulos[m.id] = padrao.modulos?.[m.id] ?? 0;
          changed = true;
        }
      });
    });

    if (changed) {
      _save(merged);
      await _saveFirebase(merged);
      console.info('[PermissoesService] Migração aplicada e sincronizada.');
    }
  }

  // ── Leitura ───────────────────────────────────────────────────────
  function _getData() {
    return _load() || JSON.parse(JSON.stringify(PERFIS_PADRAO));
  }

  function getPerfis() {
    return Object.entries(_getData()).map(([id, p]) => ({ id, ...p }));
  }

  function getPerfil(roleId) {
    if (['adm','admin'].includes(roleId)) {
      return { id: roleId, label: 'Administrador', cor: '#ef4444', icone: '👑', modulos: ADM_MODULOS, flags: {} };
    }
    const raw = _getData();
    return raw[roleId] ? { id: roleId, ...raw[roleId] } : null;
  }

  function nivelAcesso(roleId, moduloId) {
    if (['adm','admin'].includes(roleId)) return 2;
    const p = getPerfil(roleId);
    return p?.modulos?.[moduloId] ?? 0;
  }

  function temAcesso(roleId, moduloId) { return nivelAcesso(roleId, moduloId) >= 1; }
  function temAcessoCompleto(roleId, moduloId) { return nivelAcesso(roleId, moduloId) === 2; }

  function getFlag(roleId, flagId) {
    if (['adm','admin'].includes(roleId)) return false;
    const p = getPerfil(roleId);
    if (!p) return false;
    // Flag explícita no perfil salvo
    if (p.flags && typeof p.flags[flagId] === 'boolean') return p.flags[flagId];
    // Fallback para o padrão do código
    const padrao = PERFIS_PADRAO[roleId];
    if (padrao?.flags && typeof padrao.flags[flagId] === 'boolean') return padrao.flags[flagId];
    return false;
  }

  // ── CRUD de perfis ────────────────────────────────────────────────
  async function criarPerfil({ id, label, cor, icone, modulos, flags }) {
    if (!id || !label) throw new Error('id e label são obrigatórios');
    if (['adm','admin'].includes(id)) throw new Error('id reservado');
    const raw = _getData();
    if (raw[id]) throw new Error(`Perfil "${id}" já existe`);
    const modulosCompletos = {};
    MODULOS.forEach(m => { modulosCompletos[m.id] = modulos?.[m.id] ?? 0; });
    const flagsCompletas = {};
    FLAGS.forEach(f => { flagsCompletas[f.id] = flags?.[f.id] ?? false; });
    raw[id] = { label: label.trim(), cor: cor || '#64748b', icone: icone || '👤', modulos: modulosCompletos, flags: flagsCompletas };
    _save(raw);
    await _saveFirebase(raw);
    return { id, ...raw[id] };
  }

  async function atualizarPerfil(id, dados) {
    if (['adm','admin'].includes(id)) throw new Error('Perfil ADM não pode ser editado');
    const raw = _getData();
    if (!raw[id]) throw new Error(`Perfil "${id}" não encontrado`);
    Object.assign(raw[id], dados);
    _save(raw);
    await _saveFirebase(raw);
    return { id, ...raw[id] };
  }

  async function deletarPerfil(id) {
    if (['adm','admin'].includes(id)) throw new Error('Perfil ADM não pode ser removido');
    const raw = _getData();
    if (!raw[id]) throw new Error(`Perfil "${id}" não encontrado`);
    delete raw[id];
    _save(raw);
    await _saveFirebase(raw);
    return true;
  }

  async function restaurarPadroes() {
    const padrao = JSON.parse(JSON.stringify(PERFIS_PADRAO));
    _save(padrao);
    await _saveFirebase(padrao);
    return true;
  }

  window.CH.PermissoesService = {
    MODULOS, FLAGS,
    inicializar,
    getPerfis, getPerfil,
    nivelAcesso, temAcesso, temAcessoCompleto, getFlag,
    criarPerfil, atualizarPerfil, deletarPerfil, restaurarPadroes,
  };

  // Auto-inicializa após Firebase pronto
  window.CH.EventBus?.on('firebase:ready', () => inicializar());
  setTimeout(inicializar, 1000);

  console.info('%c PermissoesService ✓  (Firebase + localStorage)', 'color:#f59e0b;font-weight:bold');
})();

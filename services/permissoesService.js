'use strict';
/**
 * services/permissoesService.js — CH Geladas PDV
 * ─────────────────────────────────────────────────────────────
 * Permissões dinâmicas por perfil — configuradas pelo ADM.
 *
 * Cada perfil define por módulo:
 *   0 = Sem acesso (oculto no Hub)
 *   1 = Leitura    (visualiza, não edita)
 *   2 = Completo   (acesso total)
 *
 * Flags especiais:
 *   vendas_requer_aprovacao → vendas desse perfil entram como "pendente"
 *
 * Armazenamento: localStorage CH_PERFIS (sincronizável via Firebase)
 */

(function () {
  const STORAGE_KEY = 'CH_PERFIS';

  // ── Lista de módulos configuráveis ────────────────────────────────
  const MODULOS = [
    { id: 'vendas',              label: 'Vendas (PDV)',          icone: '🛒', cor: '#3b82f6' },
    { id: 'estoque',             label: 'Estoque',               icone: '📦', cor: '#10b981' },
    { id: 'financeiro',          label: 'Financeiro',            icone: '📊', cor: '#8b5cf6' },
    { id: 'fiado',               label: 'Fiado',                 icone: '🤝', cor: '#ef4444' },
    { id: 'comandas',            label: 'Comandas',              icone: '🍽️', cor: '#ec4899' },
    { id: 'delivery',            label: 'Delivery',              icone: '🛵', cor: '#f97316' },
    { id: 'ponto',               label: 'Ponto',                 icone: '⏱️', cor: '#14b8a6' },
    { id: 'cardapio',            label: 'Cardápio Digital',      icone: '📋', cor: '#f97316' },
    { id: 'aprovacao_controle',  label: 'Aprovação — Controle', icone: '🔍', cor: '#f59e0b' },
    { id: 'aprovacao_validacao', label: 'Aprovação — Validação',icone: '✅', cor: '#8b5cf6' },
    { id: 'relatorios',          label: 'Relatórios',            icone: '📈', cor: '#64748b' },
  ];

  // ── Flags especiais por perfil ────────────────────────────────────
  const FLAGS = [
    { id: 'vendas_requer_aprovacao', label: 'Vendas entram como Pendente (requerem aprovação do Controlador)' },
  ];

  // ── Perfis padrão (carregados se CH_PERFIS não existir) ───────────
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

  // ── ADM: sempre acesso total (não editável) ───────────────────────
  const ADM_MODULOS = {};
  MODULOS.forEach(m => { ADM_MODULOS[m.id] = 2; });

  // ── Persistência ──────────────────────────────────────────────────
  function _load() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      return raw ? JSON.parse(raw) : null;
    } catch { return null; }
  }

  function _save(perfis) {
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(perfis)); } catch(e) {}
  }

  function _inicializar() {
    const existing = _load();

    // Nenhum dado ainda: grava os padrões
    if (!existing) {
      _save(JSON.parse(JSON.stringify(PERFIS_PADRAO)));
      return;
    }

    // Dados existem: migra campos ausentes (flags, modulos novos)
    // Isso garante que deploys anteriores sem "flags" sejam corrigidos
    let changed = false;
    const merged = { ...existing };

    Object.entries(PERFIS_PADRAO).forEach(([id, padrao]) => {
      // Perfil padrão ausente na store → adiciona
      if (!merged[id]) {
        merged[id] = JSON.parse(JSON.stringify(padrao));
        changed = true;
        return;
      }
      // Flags ausentes → copia do padrão
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
      // Módulos novos ausentes → adiciona com 0
      MODULOS.forEach(m => {
        if (merged[id].modulos && merged[id].modulos[m.id] === undefined) {
          merged[id].modulos[m.id] = padrao.modulos?.[m.id] ?? 0;
          changed = true;
        }
      });
    });

    if (changed) {
      _save(merged);
      console.info('[PermissoesService] Migração de perfis aplicada.');
    }
  }

  // ── Leitura ───────────────────────────────────────────────────────

  /** Retorna todos os perfis como array [{id, label, cor, icone, modulos, flags}] */
  function getPerfis() {
    _inicializar();
    const raw = _load();
    return Object.entries(raw).map(([id, p]) => ({ id, ...p }));
  }

  /** Retorna um perfil pelo id */
  function getPerfil(roleId) {
    if (['adm', 'admin'].includes(roleId)) {
      return { id: roleId, label: 'Administrador', cor: '#ef4444', icone: '👑', modulos: ADM_MODULOS, flags: {} };
    }
    _inicializar();
    const raw = _load();
    return raw[roleId] ? { id: roleId, ...raw[roleId] } : null;
  }

  /**
   * Nível de acesso de um perfil a um módulo.
   * @returns {number} 0 = sem acesso | 1 = leitura | 2 = completo
   */
  function nivelAcesso(roleId, moduloId) {
    if (['adm', 'admin'].includes(roleId)) return 2;
    const p = getPerfil(roleId);
    if (!p) return 0;
    return p.modulos?.[moduloId] ?? 0;
  }

  /** Atalho: tem qualquer acesso (>= 1) */
  function temAcesso(roleId, moduloId) {
    return nivelAcesso(roleId, moduloId) >= 1;
  }

  /** Atalho: acesso completo (== 2) */
  function temAcessoCompleto(roleId, moduloId) {
    return nivelAcesso(roleId, moduloId) === 2;
  }

  /** Retorna valor de uma flag do perfil */
  function getFlag(roleId, flagId) {
    if (['adm', 'admin'].includes(roleId)) return false;
    const p = getPerfil(roleId);
    if (!p) return false;

    // Se flags existe e tem o campo explícito → usa
    if (p.flags && typeof p.flags[flagId] === 'boolean') {
      return p.flags[flagId];
    }

    // Fallback: se flag não está definida, usa valor padrão do PERFIS_PADRAO
    const padrao = PERFIS_PADRAO[roleId];
    if (padrao?.flags && typeof padrao.flags[flagId] === 'boolean') {
      return padrao.flags[flagId];
    }

    return false;
  }

  // ── CRUD de perfis ────────────────────────────────────────────────

  /** Cria um novo perfil personalizado */
  function criarPerfil({ id, label, cor, icone, modulos, flags }) {
    if (!id || !label) throw new Error('id e label são obrigatórios');
    if (['adm','admin'].includes(id)) throw new Error('id reservado');
    _inicializar();
    const raw = _load();
    if (raw[id]) throw new Error(`Perfil "${id}" já existe`);

    const modulosCompletos = {};
    MODULOS.forEach(m => { modulosCompletos[m.id] = modulos?.[m.id] ?? 0; });
    const flagsCompletas = {};
    FLAGS.forEach(f => { flagsCompletas[f.id] = flags?.[f.id] ?? false; });

    raw[id] = { label: label.trim(), cor: cor || '#64748b', icone: icone || '👤', modulos: modulosCompletos, flags: flagsCompletas };
    _save(raw);
    return { id, ...raw[id] };
  }

  /** Atualiza um perfil existente */
  function atualizarPerfil(id, dados) {
    if (['adm','admin'].includes(id)) throw new Error('Perfil ADM não pode ser editado');
    _inicializar();
    const raw = _load();
    if (!raw[id]) throw new Error(`Perfil "${id}" não encontrado`);
    Object.assign(raw[id], dados);
    _save(raw);
    return { id, ...raw[id] };
  }

  /** Remove um perfil (não pode remover se houver usuários ativos com ele) */
  function deletarPerfil(id) {
    if (['adm','admin'].includes(id)) throw new Error('Perfil ADM não pode ser removido');
    _inicializar();
    const raw = _load();
    if (!raw[id]) throw new Error(`Perfil "${id}" não encontrado`);
    delete raw[id];
    _save(raw);
    return true;
  }

  /** Restaura os perfis padrão */
  function restaurarPadroes() {
    _save(JSON.parse(JSON.stringify(PERFIS_PADRAO)));
    return true;
  }

  // ── Exportar ──────────────────────────────────────────────────────
  window.CH.PermissoesService = {
    MODULOS,
    FLAGS,
    getPerfis,
    getPerfil,
    nivelAcesso,
    temAcesso,
    temAcessoCompleto,
    getFlag,
    criarPerfil,
    atualizarPerfil,
    deletarPerfil,
    restaurarPadroes,
  };

  console.info('%c PermissoesService ✓  (perfis dinâmicos por módulo)', 'color:#f59e0b');
})();

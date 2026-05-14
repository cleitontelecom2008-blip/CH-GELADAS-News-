'use strict';
/**
 * services/featureFlagsService.js — CH Geladas PDV
 * ─────────────────────────────────────────────────────────────
 * Sistema de Feature Flags integrado ao SaaS (billing + planos).
 *
 * PLANOS E FLAGS:
 *   free     → vendas básicas, estoque básico
 *   basico   → + fiado, financeiro, relatórios básicos
 *   premium  → + delivery, comanda, BI avançado, multi-filial, aprovação
 *   enterprise → tudo + white-label, API própria, suporte prioritário
 *
 * USO:
 *   CH.FeatureFlags.pode('bi_avancado')      → true/false
 *   CH.FeatureFlags.planoAtual()             → 'basico'
 *   CH.FeatureFlags.listarFlags()            → { flag: bool, ... }
 *   CH.FeatureFlags.exigir('delivery', cb)   → executa cb se habilitado, senão UI de upgrade
 *
 * Modo standalone (sem SaaS):
 *   Quando SaasService não está disponível, todos os flags são habilitados
 *   (comportamento padrão do sistema legado — retrocompatível).
 *
 * Requer: core.js carregado antes.
 */

(function () {
  const { EventBus, Utils } = window.CH;

  // ══════════════════════════════════════════════════════════════════
  //  MAPEAMENTO PLANO → FLAGS
  // ══════════════════════════════════════════════════════════════════
  const PLANO_FLAGS = Object.freeze({

    free: Object.freeze({
      // PDV básico
      vendas:                   true,
      estoque_basico:           true,
      relatorio_dia:            true,
      // Limites
      max_produtos:             50,
      max_vendas_mes:           100,
      max_usuarios:             1,
      // Desabilitados
      fiado:                    false,
      financeiro:               false,
      delivery:                 false,
      comanda:                  false,
      bi_avancado:              false,
      curva_abc:                false,
      multi_filial:             false,
      aprovacao_vendas:         false,
      white_label:              false,
      backup_automatico:        false,
      telegram:                 false,
      exportar_csv:             false,
      relatorio_avancado:       false,
      ponto:                    false,
      cardapio_publico:         false,
    }),

    basico: Object.freeze({
      vendas:                   true,
      estoque_basico:           true,
      fiado:                    true,
      financeiro:               true,
      relatorio_dia:            true,
      relatorio_avancado:       true,
      exportar_csv:             true,
      telegram:                 true,
      backup_automatico:        true,
      ponto:                    true,
      cardapio_publico:         true,
      // Limites
      max_produtos:             500,
      max_vendas_mes:           9999,
      max_usuarios:             5,
      // Desabilitados
      delivery:                 false,
      comanda:                  false,
      bi_avancado:              false,
      curva_abc:                false,
      multi_filial:             false,
      aprovacao_vendas:         false,
      white_label:              false,
    }),

    premium: Object.freeze({
      vendas:                   true,
      estoque_basico:           true,
      fiado:                    true,
      financeiro:               true,
      delivery:                 true,
      comanda:                  true,
      bi_avancado:              true,
      curva_abc:                true,
      aprovacao_vendas:         true,
      relatorio_dia:            true,
      relatorio_avancado:       true,
      exportar_csv:             true,
      telegram:                 true,
      backup_automatico:        true,
      ponto:                    true,
      cardapio_publico:         true,
      // Limites
      max_produtos:             9999,
      max_vendas_mes:           9999,
      max_usuarios:             999,
      // Desabilitados
      multi_filial:             false,
      white_label:              false,
    }),

    enterprise: Object.freeze({
      vendas:                   true,
      estoque_basico:           true,
      fiado:                    true,
      financeiro:               true,
      delivery:                 true,
      comanda:                  true,
      bi_avancado:              true,
      curva_abc:                true,
      aprovacao_vendas:         true,
      relatorio_dia:            true,
      relatorio_avancado:       true,
      exportar_csv:             true,
      telegram:                 true,
      backup_automatico:        true,
      ponto:                    true,
      cardapio_publico:         true,
      multi_filial:             true,
      white_label:              true,
      // Limites ilimitados
      max_produtos:             Infinity,
      max_vendas_mes:           Infinity,
      max_usuarios:             Infinity,
    }),
  });

  // Flags extras que podem ser habilitados manualmente pelo admin
  // independente do plano (override manual para demos, betas, etc.)
  const _overrides = {};

  // ── Plano atual ───────────────────────────────────────────────────
  function planoAtual() {
    // 1. SaasService com sessão ativa
    const SaaS = window.CH?.SaasService;
    if (SaaS?.getSession) {
      const sess = SaaS.getSession();
      if (sess?.plano) return sess.plano;
    }
    // 2. saasService (módulo standalone)
    try {
      const sessStr = sessionStorage.getItem('SAAS_SESSION');
      if (sessStr) {
        const sess = JSON.parse(sessStr);
        if (sess?.plano) return sess.plano;
      }
    } catch (_) {}

    // 3. Config salva localmente
    const cfgPlano = window.CH?.Store?.getConfig?.()?.plano;
    if (cfgPlano) return cfgPlano;

    // 4. Modo standalone/legado — todos flags habilitados
    return '_standalone';
  }

  // ── Verifica uma flag ─────────────────────────────────────────────
  function pode(flag) {
    // Override manual tem prioridade
    if (flag in _overrides) return !!_overrides[flag];

    const plano = planoAtual();

    // Standalone: sem SaaS → tudo habilitado (retrocompat)
    if (plano === '_standalone') return true;

    const flags = PLANO_FLAGS[plano] || PLANO_FLAGS.free;

    // Flag booleana
    if (typeof flags[flag] === 'boolean') return flags[flag];

    // Flag numérica (limites) — retorna o valor, não boolean
    if (typeof flags[flag] === 'number') return flags[flag];

    // Flag não mapeada → false por padrão (seguro)
    return false;
  }

  /** Retorna o valor numérico de um limite (ex: max_produtos) */
  function limite(flag) {
    const plano = planoAtual();
    if (plano === '_standalone') return Infinity;
    const flags = PLANO_FLAGS[plano] || PLANO_FLAGS.free;
    return flags[flag] ?? 0;
  }

  /** Lista todas as flags do plano atual */
  function listarFlags() {
    const plano = planoAtual();
    if (plano === '_standalone') {
      // Retorna todos os flags de enterprise (modo completo)
      return { ...PLANO_FLAGS.enterprise, _plano: '_standalone' };
    }
    const flags = PLANO_FLAGS[plano] || PLANO_FLAGS.free;
    return { ...flags, ...Object.fromEntries(Object.entries(_overrides)), _plano: plano };
  }

  /**
   * Executa callback se a feature está habilitada,
   * senão dispara evento de upgrade com informação do plano necessário.
   */
  function exigir(flag, cb) {
    if (pode(flag)) {
      if (typeof cb === 'function') cb();
      return true;
    }
    // Encontra o plano mínimo que habilita essa flag
    const planoMinimo = _encontrarPlanoMinimo(flag);
    EventBus.emit('feature:bloqueada', { flag, planoMinimo, planoAtual: planoAtual() });

    // Toast de upgrade (se UIService disponível)
    const planoLabel = { basico: 'Básico', premium: 'Premium', enterprise: 'Enterprise' };
    const msg = planoMinimo
      ? `Esta funcionalidade requer o plano ${planoLabel[planoMinimo] || planoMinimo}.`
      : 'Recurso não disponível no plano atual.';

    window.CH?.UIService?.showToast?.('Recurso bloqueado', msg, 'warning');
    window.CH?.SoundService?.denied?.();
    return false;
  }

  function _encontrarPlanoMinimo(flag) {
    for (const plano of ['free', 'basico', 'premium', 'enterprise']) {
      const flags = PLANO_FLAGS[plano];
      if (flags[flag] === true || (typeof flags[flag] === 'number' && flags[flag] > 0)) {
        return plano;
      }
    }
    return null;
  }

  /** Override manual — apenas admin pode chamar */
  function setOverride(flag, valor) {
    if (valor === null || valor === undefined) {
      delete _overrides[flag];
    } else {
      _overrides[flag] = valor;
    }
    EventBus.emit('featureflags:atualizado', { flag, valor });
  }

  /** Define plano manualmente (para modo standalone sem SaaS) */
  function setPlano(plano) {
    if (!PLANO_FLAGS[plano]) throw new Error(`Plano desconhecido: ${plano}`);
    window.CH?.Store?.mutateConfig?.(cfg => { cfg.plano = plano; });
    EventBus.emit('featureflags:plano-alterado', { plano });
  }

  /** Informações de UI sobre os planos (para tela de upgrade) */
  function getInfoPlanos() {
    return [
      {
        id:       'free',
        label:    'Grátis',
        preco:    0,
        cor:      '#64748b',
        destaque: false,
        recursos: ['PDV básico', 'Até 50 produtos', '100 vendas/mês', '1 usuário'],
      },
      {
        id:       'basico',
        label:    'Básico',
        preco:    4990, // centavos
        cor:      '#3b82f6',
        destaque: false,
        recursos: ['Tudo do Grátis', 'Fiado + Financeiro', 'Relatórios completos', 'Telegram', '5 usuários', 'Backup automático'],
      },
      {
        id:       'premium',
        label:    'Premium',
        preco:    9990,
        cor:      '#a78bfa',
        destaque: true,
        recursos: ['Tudo do Básico', 'Delivery + Comanda', 'Dashboard BI + Curva ABC', 'Aprovação de vendas', 'Usuários ilimitados'],
      },
      {
        id:       'enterprise',
        label:    'Enterprise',
        preco:    null, // sob consulta
        cor:      '#f59e0b',
        destaque: false,
        recursos: ['Tudo do Premium', 'Multi-filial', 'White-label', 'API própria', 'Suporte prioritário'],
      },
    ];
  }

  // ── Exportar ──────────────────────────────────────────────────────
  window.CH.FeatureFlags = {
    pode,
    limite,
    listarFlags,
    exigir,
    setOverride,
    setPlano,
    planoAtual,
    getInfoPlanos,
  };

  console.info('%c FeatureFlags ✓  (plano:', planoAtual(), ')', 'color:#10b981;font-weight:bold');
})();

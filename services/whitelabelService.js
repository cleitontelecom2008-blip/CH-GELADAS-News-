'use strict';
/**
 * services/whitelabelService.js — CH Geladas PDV
 * ─────────────────────────────────────────────────────────────
 * Engine de white-label: personaliza nome, cores, logo e textos
 * da interface sem alterar nenhum HTML.
 *
 * COMO FUNCIONA:
 *   Injeta variáveis CSS em :root e substitui textos do <title>
 *   e elementos com data-wl="campo".
 *
 * CONFIG (salva em CH_CONFIG.whitelabel):
 *   {
 *     nomeEmpresa:   'CH Geladas',
 *     nomeApp:       'PDV',
 *     corPrimaria:   '#3b82f6',    // botões, destaques
 *     corSecundaria: '#10b981',    // sucesso, badges
 *     corBg:         '#0f172a',    // fundo
 *     corSurface:    '#1e293b',    // cards
 *     logoUrl:       '',           // URL da imagem (base64 ou https)
 *     favicon:       '',
 *     rodape:        'CH Geladas PDV',
 *   }
 *
 * USO DIRETO:
 *   CH.WhitelabelService.aplicar({ nomeEmpresa: 'Minha Loja', corPrimaria: '#f59e0b' })
 *   CH.WhitelabelService.resetar()
 *
 * HOOK AUTOMÁTICO:
 *   Ao inicializar, lê a config salva e aplica.
 *   Ao fazer login SaaS, lê config da empresa e aplica.
 *
 * MARCAÇÃO HTML (opcional):
 *   <span data-wl="nomeEmpresa"></span>  → preenchido automaticamente
 *   <img  data-wl="logo" />              → src = logoUrl
 *
 * Requer: core.js carregado antes (window.CH disponível)
 */

(function () {
  const { Store, EventBus } = window.CH;

  // ── Temas pré-definidos ──────────────────────────────────────────
  const TEMAS = {
    default: {
      corPrimaria:   '#3b82f6',
      corSecundaria: '#10b981',
      corBg:         '#0f172a',
      corSurface:    '#1e293b',
      corBorda:      '#334155',
      corTexto:      '#f1f5f9',
      corMuted:      '#94a3b8',
    },
    laranja: {
      corPrimaria:   '#f59e0b',
      corSecundaria: '#10b981',
      corBg:         '#0f0a00',
      corSurface:    '#1a1200',
      corBorda:      '#3d2e00',
      corTexto:      '#fef9ee',
      corMuted:      '#a38b3a',
    },
    roxo: {
      corPrimaria:   '#a78bfa',
      corSecundaria: '#34d399',
      corBg:         '#0d0a1e',
      corSurface:    '#160f2e',
      corBorda:      '#2e1f5e',
      corTexto:      '#f3f0ff',
      corMuted:      '#8b6fbf',
    },
    verde: {
      corPrimaria:   '#10b981',
      corSecundaria: '#3b82f6',
      corBg:         '#011208',
      corSurface:    '#061a0e',
      corBorda:      '#0e3320',
      corTexto:      '#ecfdf5',
      corMuted:      '#5a9b79',
    },
    vermelho: {
      corPrimaria:   '#ef4444',
      corSecundaria: '#f59e0b',
      corBg:         '#100505',
      corSurface:    '#1c0a0a',
      corBorda:      '#3b1212',
      corTexto:      '#fff1f1',
      corMuted:      '#9b5555',
    },
  };

  // ── Lê config salva ──────────────────────────────────────────────
  function _lerConfig() {
    return Store.getConfig()?.whitelabel || {};
  }

  // ── Aplica CSS vars + DOM ────────────────────────────────────────
  function aplicar(cfg = {}) {
    const salvo  = _lerConfig();
    const merged = { ...salvo, ...cfg };

    // Salva no store se veio de fora
    if (Object.keys(cfg).length) {
      Store.mutateConfig(c => { c.whitelabel = { ...salvo, ...cfg }; });
    }

    const tema = TEMAS[merged.tema] || TEMAS.default;
    const corP = merged.corPrimaria   || tema.corPrimaria;
    const corS = merged.corSecundaria || tema.corSecundaria;

    // ── Injeta CSS custom properties ────────────────────────────────
    let style = document.getElementById('__wl_style');
    if (!style) {
      style = document.createElement('style');
      style.id = '__wl_style';
      document.head.appendChild(style);
    }

    style.textContent = `
      :root {
        --wl-primary:   ${corP};
        --wl-secondary: ${corS};
        --wl-bg:        ${merged.corBg      || tema.corBg};
        --wl-surface:   ${merged.corSurface || tema.corSurface};
        --wl-border:    ${merged.corBorda   || tema.corBorda};
        --wl-text:      ${merged.corTexto   || tema.corTexto};
        --wl-muted:     ${merged.corMuted   || tema.corMuted};
      }
      /* Substitui classes do Tailwind mais usadas no PDV */
      .bg-blue-600,
      [class*="bg-blue-600"] { background-color: ${corP} !important; }
      .hover\\:bg-blue-500:hover { background-color: ${corP}cc !important; }
      .text-blue-400 { color: ${corP} !important; }
      .text-blue-300 { color: ${corP}cc !important; }
      .border-blue-500 { border-color: ${corP} !important; }
      .ring-blue-500   { --tw-ring-color: ${corP} !important; }
      .text-emerald-400, .text-green-400 { color: ${corS} !important; }
      .bg-emerald-500\\/10, .bg-green-500\\/10 { background-color: ${corS}1a !important; }
      /* Variáveis também para o bi-dashboard */
      .btn-primary { background: ${corP} !important; }
    `;

    // ── Preenche elementos data-wl ──────────────────────────────────
    if (merged.nomeEmpresa) {
      document.querySelectorAll('[data-wl="nomeEmpresa"]')
        .forEach(el => { el.textContent = merged.nomeEmpresa; });
      // Atualiza title se contiver "CH Geladas"
      if (document.title.includes('CH Geladas')) {
        document.title = document.title.replace('CH Geladas', merged.nomeEmpresa);
      }
    }

    if (merged.nomeApp) {
      document.querySelectorAll('[data-wl="nomeApp"]')
        .forEach(el => { el.textContent = merged.nomeApp; });
    }

    if (merged.rodape) {
      document.querySelectorAll('[data-wl="rodape"]')
        .forEach(el => { el.textContent = merged.rodape; });
    }

    // ── Logo ─────────────────────────────────────────────────────────
    if (merged.logoUrl) {
      document.querySelectorAll('[data-wl="logo"]').forEach(el => {
        if (el.tagName === 'IMG') el.src = merged.logoUrl;
        else el.style.backgroundImage = `url(${merged.logoUrl})`;
      });
    }

    // ── Favicon ──────────────────────────────────────────────────────
    if (merged.favicon) {
      let link = document.querySelector("link[rel*='icon']");
      if (!link) { link = document.createElement('link'); link.rel='icon'; document.head.appendChild(link); }
      link.href = merged.favicon;
    }

    EventBus.emit('whitelabel:aplicado', merged);
    console.info('[WhitelabelService] Tema aplicado:', merged.nomeEmpresa || 'default');
  }

  /** Reseta para o visual padrão do CH Geladas */
  function resetar() {
    const style = document.getElementById('__wl_style');
    if (style) style.textContent = '';
    Store.mutateConfig(c => { delete c.whitelabel; });
    EventBus.emit('whitelabel:resetado');
  }

  /** Lista temas disponíveis */
  function getTemas() { return Object.keys(TEMAS); }

  /** Aplica apenas pelo nome do tema pré-definido */
  function aplicarTema(nomeTema) {
    const t = TEMAS[nomeTema];
    if (!t) throw new Error(`Tema '${nomeTema}' não existe. Disponíveis: ${Object.keys(TEMAS).join(', ')}`);
    aplicar({ tema: nomeTema, ...t });
  }

  // ── Inicialização automática ─────────────────────────────────────
  function _init() {
    const cfg = _lerConfig();
    if (Object.keys(cfg).length) aplicar(cfg);
  }

  // ── Hook: aplica config da empresa após login SaaS ───────────────
  EventBus.on('saas:login', async (sess) => {
    if (!sess?.empresaId) return;
    try {
      // Tenta buscar config de branding da empresa no Firestore
      const FB = window.CH?.FirebaseService;
      if (!FB?.isReady?.()) return;
      const snap = await FB.ler?.('branding_' + sess.empresaId);
      if (snap) aplicar(snap);
    } catch (_) {}
  });

  // Aplica na inicialização (após DOM pronto)
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', _init);
  } else {
    _init();
  }

  window.CH.WhitelabelService = { aplicar, resetar, getTemas, aplicarTema, getConfig: _lerConfig };
  console.info('%c WhitelabelService ✓  (white-label engine | CSS vars | DOM binding)', 'color:#10b981;font-weight:bold');
})();

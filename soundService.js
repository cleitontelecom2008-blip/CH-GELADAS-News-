'use strict';
/**
 * services/soundService.js — CH Geladas PDV
 * ─────────────────────────────────────────────────────────────
 * Feedback sonoro 100% via Web Audio API.
 * Zero dependências externas. Compatível com iOS/Android/Desktop.
 *
 * USO:
 *   window.CH.SoundService.success()
 *   window.CH.SoundService.error()
 *   window.CH.SoundService.setEnabled(false)   → mute
 *   window.CH.SoundService.setVolume(0.3)      → 30%
 *
 * HOOKS AUTOMÁTICOS (EventBus):
 *   venda:finalizada → success()
 *   venda:pendente   → warning()
 *   venda:cancelada  → error()
 *   auth:login       → notification()
 *   cart:item:added  → click()
 *   estoque:ruptura  → denied()
 *   estoque:baixo    → lowStock()
 *
 * Requer: core.js carregado antes (window.CH disponível)
 */

(function () {
  // ── Estado interno ────────────────────────────────────────────────
  let _ctx     = null;
  let _enabled = true;
  let _volume  = 0.4;

  // Persiste preferência do usuário
  try {
    const saved = localStorage.getItem('CH_SOUND_CFG');
    if (saved) {
      const cfg = JSON.parse(saved);
      _enabled = cfg.enabled ?? true;
      _volume  = cfg.volume  ?? 0.4;
    }
  } catch (_) {}

  function _salvarPrefs() {
    try { localStorage.setItem('CH_SOUND_CFG', JSON.stringify({ enabled: _enabled, volume: _volume })); } catch (_) {}
  }

  // ── AudioContext (lazy init — obrigatório pela política de autoplay) ──
  function _getCtx() {
    if (!_ctx) {
      try {
        _ctx = new (window.AudioContext || window.webkitAudioContext)();
      } catch (e) { return null; }
    }
    // Retoma contexto suspenso (iOS suspende em background)
    if (_ctx.state === 'suspended') _ctx.resume().catch(() => {});
    return _ctx;
  }

  // ── Tom básico ───────────────────────────────────────────────────
  function _tom(freq, dur, tipo = 'sine', vol = _volume) {
    if (!_enabled) return;
    const ctx = _getCtx();
    if (!ctx) return;
    try {
      const t   = ctx.currentTime;
      const osc = ctx.createOscillator();
      const env = ctx.createGain();
      osc.connect(env);
      env.connect(ctx.destination);
      osc.type = tipo;
      osc.frequency.setValueAtTime(freq, t);
      // Envelope: attack → sustain → release
      env.gain.setValueAtTime(0, t);
      env.gain.linearRampToValueAtTime(vol, t + 0.01);
      env.gain.setValueAtTime(vol, t + dur * 0.7);
      env.gain.exponentialRampToValueAtTime(0.001, t + dur);
      osc.start(t);
      osc.stop(t + dur + 0.05);
    } catch (_) {}
  }

  // ── Sequência de tons ─────────────────────────────────────────────
  function _seq(notas) {
    if (!_enabled) return;
    notas.forEach(({ freq, dur, delay = 0, tipo = 'sine', vol }) => {
      setTimeout(() => _tom(freq, dur, tipo, vol ?? _volume), Math.round(delay * 1000));
    });
  }

  // ────────────────────────────────────────────────────────────────
  //  CATÁLOGO DE SONS
  // ────────────────────────────────────────────────────────────────

  /** Venda concluída — dois bips ascendentes */
  function success() {
    _seq([
      { freq: 880,  dur: 0.11, delay: 0    },
      { freq: 1108, dur: 0.18, delay: 0.13 },
    ]);
  }

  /** Erro operacional — buzz grave */
  function error() {
    _seq([
      { freq: 160, dur: 0.18, delay: 0,    tipo: 'sawtooth' },
      { freq: 110, dur: 0.25, delay: 0.20, tipo: 'sawtooth' },
    ]);
  }

  /** Alerta / atenção — bip duplo médio */
  function warning() {
    _seq([
      { freq: 660, dur: 0.09, delay: 0    },
      { freq: 660, dur: 0.09, delay: 0.14 },
    ]);
  }

  /** Leitura código de barras — bip curto agudo */
  function scan() {
    _tom(1800, 0.07, 'square', _volume * 0.45);
  }

  /** Caixa registradora — ding metálico */
  function cashRegister() {
    _seq([
      { freq: 1320, dur: 0.06, delay: 0,    tipo: 'triangle' },
      { freq: 1760, dur: 0.14, delay: 0.07, tipo: 'triangle' },
      { freq: 2093, dur: 0.22, delay: 0.20, tipo: 'triangle', vol: _volume * 0.6 },
    ]);
  }

  /** Clique sutil — item adicionado ao carrinho */
  function click() {
    _tom(440, 0.035, 'sine', _volume * 0.25);
  }

  /** Acesso negado / operação bloqueada */
  function denied() {
    _seq([
      { freq: 320, dur: 0.14, delay: 0,    tipo: 'square', vol: _volume * 0.6 },
      { freq: 200, dur: 0.28, delay: 0.16, tipo: 'square', vol: _volume * 0.6 },
    ]);
  }

  /** Notificação suave — informação */
  function notification() {
    _seq([
      { freq: 523, dur: 0.09, delay: 0,    tipo: 'triangle' },
      { freq: 659, dur: 0.14, delay: 0.11, tipo: 'triangle' },
    ]);
  }

  /** Estoque baixo — alerta descendente */
  function lowStock() {
    _seq([
      { freq: 440, dur: 0.09, delay: 0    },
      { freq: 330, dur: 0.09, delay: 0.12 },
      { freq: 220, dur: 0.16, delay: 0.24 },
    ]);
  }

  /** Aprovação / validação positiva */
  function approved() {
    _seq([
      { freq: 523, dur: 0.08, delay: 0    },
      { freq: 659, dur: 0.08, delay: 0.10 },
      { freq: 784, dur: 0.12, delay: 0.20 },
    ]);
  }

  // ── API pública ──────────────────────────────────────────────────
  function setEnabled(v) {
    _enabled = !!v;
    _salvarPrefs();
    if (!_enabled && _ctx) { try { _ctx.close(); _ctx = null; } catch (_) {} }
  }

  function setVolume(v) {
    _volume = Math.max(0, Math.min(1, Number(v) || 0));
    _salvarPrefs();
  }

  const SoundService = {
    setEnabled, setVolume,
    isEnabled: () => _enabled,
    getVolume:  () => _volume,
    // Sons
    success, error, warning, scan, cashRegister,
    click, denied, notification, lowStock, approved,
  };

  // ── Hooks automáticos via EventBus ────────────────────────────────
  const EB = window.CH?.EventBus;
  if (EB) {
    EB.on('venda:finalizada',    () => SoundService.success());
    EB.on('venda:pendente',      () => SoundService.warning());
    EB.on('venda:cancelada',     () => SoundService.error());
    EB.on('venda:aprovada',      () => SoundService.approved());
    EB.on('auth:login',          () => SoundService.notification());
    EB.on('cart:item:added',     () => SoundService.click());
    EB.on('estoque:ruptura',     () => SoundService.denied());
    EB.on('estoque:baixo',       () => SoundService.lowStock());
    EB.on('aprovacao:aprovada',  () => SoundService.approved());
    EB.on('aprovacao:rejeitada', () => SoundService.denied());
    EB.on('fiado:lancado',       () => SoundService.notification());
  }

  window.CH.SoundService = SoundService;
  console.info('%c SoundService ✓  (Web Audio API | hooks automáticos)', 'color:#10b981;font-weight:bold');
})();

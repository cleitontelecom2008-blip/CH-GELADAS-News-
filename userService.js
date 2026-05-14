'use strict';
/**
 * services/userService.js — CH Geladas PDV
 * Usuários salvos no Firebase Firestore (coleção "ch_usuarios")
 * + cache local no localStorage.
 * Nunca se perdem ao limpar histórico do browser.
 */

(function () {
  const STORAGE_KEY  = 'CH_USERS';
  const FB_DOC       = 'ch_usuarios'; // documento dentro de ch_dados

  // ── localStorage ─────────────────────────────────────────────────
  function _loadLocal() {
    try { return JSON.parse(localStorage.getItem(STORAGE_KEY) || '[]'); } catch { return []; }
  }
  function _saveLocal(users) {
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(users)); } catch(e) {}
  }

  // ── Firebase ──────────────────────────────────────────────────────
  async function _saveFirebase(users) {
    try {
      const FS = window.CH.FirebaseService;
      if (!FS || !FS.isReady?.()) return;
      await FS.salvar(FB_DOC, users);
    } catch(e) { console.warn('[UserService] Firebase salvar falhou:', e.message); }
  }

  async function _loadFirebase() {
    try {
      const FS = window.CH.FirebaseService;
      if (!FS || !FS.isReady?.()) return null;
      const data = await FS.ler(FB_DOC);
      return Array.isArray(data) ? data : null;
    } catch(e) { console.warn('[UserService] Firebase ler falhou:', e.message); return null; }
  }

  // ── Inicialização: Firebase → localStorage ────────────────────────
  async function inicializar() {
    const local = _loadLocal();
    if (local.length > 0) return; // já tem dados locais

    const remoto = await _loadFirebase();
    if (remoto && remoto.length > 0) {
      _saveLocal(remoto);
      console.info(`[UserService] ${remoto.length} usuário(s) restaurados do Firebase.`);
    }
  }

  // ── CRUD ──────────────────────────────────────────────────────────
  async function criarUsuario({ nome, role, pin }) {
    // Aceita perfis fixos OU dinâmicos do PermissoesService
    const perfilDinamico = window.CH?.PermissoesService?.getPerfil(role);
    const ROLES_FIXOS = ['adm','admin','gerente','operador','pdv','entregador',
                         'colaborador','controlador','validador','analista'];
    if (!ROLES_FIXOS.includes(role) && !perfilDinamico) {
      throw new Error(`Perfil inválido: ${role}`);
    }
    if (!pin || String(pin).length < 3) throw new Error('PIN deve ter pelo menos 3 dígitos');

    const users   = _loadLocal();
    const pinHash = await window.CH.CryptoService.sha256(String(pin).trim());
    if (users.find(u => u.pinHash === pinHash)) throw new Error('Este PIN já está em uso');

    const user = {
      id:        window.CH.Utils.generateId(),
      nome:      nome.trim(),
      role,
      pinHash,
      ativo:     true,
      criadoEm:  window.CH.Utils.nowISO(),
      criadoPor: window.CH.AuthService.getNome(),
    };

    users.push(user);
    _saveLocal(users);
    await _saveFirebase(users); // ← salva na nuvem
    window.CH.EventBus.emit('usuario:criado', { id: user.id, nome: user.nome, role: user.role });
    return { ...user, pinHash: undefined };
  }

  async function atualizarUsuario(id, campos) {
    const users = _loadLocal();
    const idx   = users.findIndex(u => u.id === id);
    if (idx < 0) throw new Error(`Usuário ${id} não encontrado`);
    if (campos.pin) {
      campos.pinHash = await window.CH.CryptoService.sha256(String(campos.pin).trim());
      delete campos.pin;
    }
    Object.assign(users[idx], campos, { updatedAt: window.CH.Utils.nowISO() });
    _saveLocal(users);
    await _saveFirebase(users);
    return { ...users[idx], pinHash: undefined };
  }

  async function desativarUsuario(id) {
    return atualizarUsuario(id, { ativo: false });
  }

  function getUsuarios({ apenasAtivos = true } = {}) {
    let users = _loadLocal();
    if (apenasAtivos) users = users.filter(u => u.ativo);
    return users.map(u => ({ ...u, pinHash: undefined }));
  }

  async function validarPin(pin) {
    const pinHash = await window.CH.CryptoService.sha256(String(pin).trim());
    const users   = _loadLocal();
    const user    = users.find(u => u.ativo && u.pinHash === pinHash);
    if (user) return { id: user.id, nome: user.nome, role: user.role };

    // Fallback: PINs legados (admin/001, pdv/123)
    const legacyRole = await window.CH.CryptoService.validatePin(pin);
    if (legacyRole) {
      return { id: 'legacy', nome: legacyRole === 'admin' ? 'Administrador' : 'PDV', role: legacyRole };
    }
    return null;
  }

  window.CH.UserService = {
    inicializar,
    criarUsuario,
    atualizarUsuario,
    desativarUsuario,
    getUsuarios,
    validarPin,
  };

  // Auto-inicializa após Firebase estar pronto
  window.CH.EventBus?.on('firebase:ready', () => inicializar());
  // Tenta imediatamente também
  setTimeout(inicializar, 1500);

  console.info('%c UserService ✓  (Firebase + localStorage)', 'color:#10b981;font-weight:bold');
})();

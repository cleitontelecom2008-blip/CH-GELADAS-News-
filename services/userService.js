'use strict';
/**
 * services/userService.js — CH Geladas PDV
 * Login por NOME + SENHA (sincronizado no Firestore)
 */

(function () {
  const { Store, AuthService, Utils, EventBus, CryptoService } = window.CH;

  const USERS_KEY = 'CH_USERS';

  const PERMISSOES_ROLES = {
    adm: {
      label:   'Administrador',
      cor:     '#ef4444',
      icone:   '👑',
      acessos: ['estoque','vendas','financeiro','fiado','comandas','delivery','ponto','config','auditoria','relatorios','usuarios','aprovacao'],
    },
    admin: {
      label:   'Administrador',
      cor:     '#ef4444',
      icone:   '👑',
      acessos: ['estoque','vendas','financeiro','fiado','comandas','delivery','ponto','config','auditoria','relatorios','usuarios','aprovacao'],
    },
    controlador: {
      label:   'Controlador',
      cor:     '#f59e0b',
      icone:   '🔍',
      acessos: ['vendas:leitura','aprovacao:controle','relatorios'],
    },
    validador: {
      label:   'Validador',
      cor:     '#8b5cf6',
      icone:   '✅',
      acessos: ['vendas:leitura','aprovacao:validacao','estoque:leitura','financeiro:leitura','relatorios'],
    },
    colaborador: {
      label:   'Colaborador',
      cor:     '#3b82f6',
      icone:   '🛒',
      acessos: ['vendas'],
    },
    gerente: {
      label:   'Gerente',
      cor:     '#f59e0b',
      icone:   '📊',
      acessos: ['estoque','vendas','financeiro','fiado','comandas','delivery','ponto','relatorios'],
    },
    operador: {
      label:   'Operador',
      cor:     '#10b981',
      icone:   '🖥️',
      acessos: ['vendas','estoque:leitura','comandas','delivery'],
    },
    entregador: {
      label:   'Entregador',
      cor:     '#06b6d4',
      icone:   '🚴',
      acessos: ['delivery','pedidos:leitura'],
    },
    pdv: {
      label:   'PDV (Caixa)',
      cor:     '#10b981',
      icone:   '💵',
      acessos: ['vendas'],
    },
  };

  // ─── localStorage ────────────────────────────────────────────────
  function _loadUsers() {
    try { return JSON.parse(localStorage.getItem(USERS_KEY) || '[]'); } catch { return []; }
  }
  function _saveUsers(users) {
    try { localStorage.setItem(USERS_KEY, JSON.stringify(users)); } catch(e) {}
  }

  // ─── Firestore sync ──────────────────────────────────────────────
  async function _pushFirebase(users) {
    try {
      const fb = window.CH?.FirebaseService;
      if (!fb?.isReady) return;
      await fb.salvar('usuarios', users);
      console.info('[UserService] Usuarios sincronizados no Firestore.');
    } catch(e) {
      console.warn('[UserService] Push Firebase falhou:', e.message);
    }
  }

  async function syncUsers() {
    try {
      const fb = window.CH?.FirebaseService;
      if (!fb?.isReady) return;
      const remote = await fb.ler('usuarios');
      if (!Array.isArray(remote) || remote.length === 0) return;
      const local  = _loadUsers();
      const merged = [...remote];
      for (const u of local) {
        if (!merged.find(r => r.id === u.id)) merged.push(u);
      }
      _saveUsers(merged);
      console.info('[UserService] ' + merged.length + ' usuario(s) carregado(s) do Firestore.');
    } catch(e) {
      console.warn('[UserService] syncUsers falhou:', e.message);
    }
  }

  // ─── CRUD ────────────────────────────────────────────────────────
  async function criarUsuario({ nome, role, senha, pin }) {
    const credencial = senha || pin;
    const perfilDinamico = window.CH?.PermissoesService?.getPerfil(role);
    if (!PERMISSOES_ROLES[role] && !perfilDinamico) throw new Error('Papel invalido: ' + role);
    if (!credencial || String(credencial).trim().length < 3)
      throw new Error('Senha deve ter pelo menos 3 caracteres');

    const users     = _loadUsers();
    const senhaHash = await CryptoService.sha256(String(credencial).trim());
    const nomeNorm  = nome.trim().toLowerCase();

    if (users.find(u => u.nomeNorm === nomeNorm && u.ativo !== false))
      throw new Error('Ja existe um usuario ativo com este nome');

    const user = {
      id:        Utils.generateId(),
      nome:      nome.trim(),
      nomeNorm,
      role,
      senhaHash,
      ativo:     true,
      criadoEm:  Utils.nowISO(),
      criadoPor: AuthService.getNome(),
    };

    users.push(user);
    _saveUsers(users);
    await _pushFirebase(users);
    EventBus.emit('usuario:criado', { id: user.id, nome: user.nome, role: user.role });
    return { ...user, senhaHash: undefined };
  }

  async function atualizarUsuario(id, campos) {
    const users = _loadUsers();
    const idx   = users.findIndex(u => u.id === id);
    if (idx < 0) throw new Error('Usuario ' + id + ' nao encontrado');
    const novaCred = campos.senha || campos.pin;
    if (novaCred) {
      campos.senhaHash = await CryptoService.sha256(String(novaCred).trim());
      delete campos.senha;
      delete campos.pin;
    }
    Object.assign(users[idx], campos, { updatedAt: Utils.nowISO() });
    _saveUsers(users);
    await _pushFirebase(users);
    return { ...users[idx], senhaHash: undefined, pinHash: undefined };
  }

  function desativarUsuario(id) { return atualizarUsuario(id, { ativo: false }); }

  function getUsuarios({ apenasAtivos = true } = {}) {
    let users = _loadUsers();
    if (apenasAtivos) users = users.filter(u => u.ativo);
    return users.map(u => ({ ...u, senhaHash: undefined, pinHash: undefined }));
  }

  // ─── Validacao ───────────────────────────────────────────────────
  async function validarCredenciais(nome, senha) {
    const hash     = await CryptoService.sha256(String(senha).trim());
    const users    = _loadUsers();
    const nomeNorm = nome.trim().toLowerCase();
    const user     = users.find(u =>
      u.ativo && u.nomeNorm === nomeNorm &&
      (u.senhaHash === hash || u.pinHash === hash)
    );
    if (user) return { id: user.id, nome: user.nome, role: user.role };
    return null;
  }

  // Compat legado
  async function validarPin(pin) {
    const hash  = await CryptoService.sha256(String(pin).trim());
    const users = _loadUsers();
    const user  = users.find(u => u.ativo && (u.senhaHash === hash || u.pinHash === hash));
    if (user) return { id: user.id, nome: user.nome, role: user.role };
    const legacyRole = await window.CH.CryptoService.validatePin(pin);
    if (legacyRole) {
      return { id: 'legacy', nome: legacyRole === 'admin' ? 'Administrador' : 'Colaborador', role: legacyRole };
    }
    return null;
  }

  // ─── Login ───────────────────────────────────────────────────────
  async function login(nome, senha) {
    let user = null;

    // 1) nome + senha (novo fluxo)
    if (nome && senha !== undefined && nome.trim()) {
      user = await validarCredenciais(nome, senha);
    }

    // 2) Fallback legacy: admin/pdv por PIN embutido
    if (!user) {
      const credencial = senha !== undefined ? senha : nome;
      const legacyRole = await window.CH.CryptoService.validatePin(credencial);
      if (legacyRole) {
        user = {
          id:   'legacy',
          nome: legacyRole === 'admin' ? 'Administrador' : 'Colaborador',
          role: legacyRole,
        };
      }
    }

    if (!user) return false;

    if (user.id === 'legacy') {
      const credencial = senha !== undefined ? senha : nome;
      return window.CH.AuthService.login(credencial);
    }

    const session = {
      role:    user.role,
      nome:    user.nome,
      userId:  user.id,
      loginAt: Date.now(),
    };
    sessionStorage.setItem(window.CH.CONSTANTS.SESSION_KEY, JSON.stringify(session));
    window.CH.AuthService._session = session;

    const isFullAdmin = ['adm','admin'].includes(user.role);
    const credFinal   = senha !== undefined ? senha : nome;
    if (isFullAdmin) {
      await window.CH.FirebaseService.init();
      await window.CH.FirebaseService.gerarAdminToken(String(credFinal).trim());
    } else {
      window.CH.FirebaseService.clearAdminToken();
    }

    setTimeout(() => {
      window.CH.FirebaseService.init().then(() => {
        window.CH.FirebaseService.subscribeRealtime();
        syncUsers();
      });
    }, 300);
    setTimeout(() => window.CH.SyncService.pull(), 800);

    window.CH.EventBus.emit('auth:login', { role: user.role });
    return user;
  }

  // ─── Permissoes ──────────────────────────────────────────────────
  function temAcesso(role, modulo) {
    const perms = PERMISSOES_ROLES[role];
    if (!perms) return false;
    if (role === 'adm' || role === 'admin') return true;
    return perms.acessos.some(a => a === modulo || a === modulo + ':leitura' || a.startsWith(modulo));
  }

  function podeEscrever(role, modulo) {
    if (role === 'adm' || role === 'admin' || role === 'gerente') return true;
    const perms = PERMISSOES_ROLES[role];
    if (!perms) return false;
    return perms.acessos.includes(modulo);
  }

  function getRoleInfo(role) { return PERMISSOES_ROLES[role] || null; }
  function getRoles() { return Object.entries(PERMISSOES_ROLES).map(([id, info]) => ({ id, ...info })); }

  window.CH.UserService = {
    criarUsuario, atualizarUsuario, desativarUsuario,
    getUsuarios, validarCredenciais, validarPin, login, syncUsers,
    temAcesso, podeEscrever,
    getRoleInfo, getRoles,
    PERMISSOES_ROLES,
  };

  EventBus.on('firebase:ready', () => { syncUsers().catch(() => {}); });

  console.info('%c UserService OK (nome+senha | Firestore sync)', 'color:#10b981');
})();

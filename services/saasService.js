'use strict';
/**
 * services/saasService.js — CH Geladas SaaS
 *
 * Responsabilidades:
 *  - Registro de empresa (onboarding)
 *  - Login multi-tenant (empresaId isolado)
 *  - Planos: free / basico / premium
 *  - Convites por código (6 chars, 24h)
 *  - CRUD de usuários por empresa
 *  - Isolamento de dados em saas_dados/{empresaId}/...
 */

(function () {
  const { Utils, EventBus, CryptoService } = window.CH;

  // ─── Firebase helpers ─────────────────────────────────────────────
  // Reutiliza a instância do core.js (que já faz signInAnonymously)
  let _db = null, _fb = null;

  async function _ensureDB() {
    if (_db && _fb) return true;

    // 1) Garante que core.js inicializou o Firebase (com auth anônima)
    const FB = window.CH?.FirebaseService;
    if (FB) {
      await FB.init();  // idempotente — só inicializa se ainda não fez
    }

    // 2) Importa o SDK Firestore e reutiliza o app já criado
    _fb = await import('https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js');
    const { getApps, getApp } =
      await import('https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js');

    const app = getApps().length ? getApp() : null;
    if (!app) throw new Error('Firebase não inicializado. Recarregue a página.');

    // 3) Garante auth anônima mesmo sem core.js na página
    const { getAuth, signInAnonymously } =
      await import('https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js');
    const auth = getAuth(app);
    if (!auth.currentUser) {
      await signInAnonymously(auth);
    }

    _db = _fb.getFirestore(app);
    return true;
  }

  // ─── PLANOS ───────────────────────────────────────────────────────
  const PLANOS = {
    free:    { label: 'Grátis',   cor: '#64748b', maxUsuarios: 1,  vendasMes: 100,  modulos: ['vendas'] },
    basico:  { label: 'Básico',   cor: '#3b82f6', maxUsuarios: 5,  vendasMes: 9999, modulos: ['vendas','estoque','fiado','financeiro'] },
    premium: { label: 'Premium',  cor: '#a78bfa', maxUsuarios: 999,vendasMes: 9999, modulos: ['vendas','estoque','fiado','financeiro','delivery','comanda','relatorios','aprovacao'] },
  };

  function getPlanos() { return PLANOS; }
  function getPlano(id) { return PLANOS[id] || PLANOS.free; }

  // ─── SESSION ──────────────────────────────────────────────────────
  const SESS_KEY = 'SAAS_SESSION';

  function _saveSession(s) { sessionStorage.setItem(SESS_KEY, JSON.stringify(s)); }
  function getSession()    {
    try { return JSON.parse(sessionStorage.getItem(SESS_KEY) || 'null'); } catch { return null; }
  }
  function clearSession()  { sessionStorage.removeItem(SESS_KEY); }
  function isLogged()      { return !!getSession(); }
  function getEmpresaId()  { return getSession()?.empresaId || null; }
  function getNome()       { return getSession()?.nome || 'Usuário'; }
  function getRole()       { return getSession()?.role || 'colaborador'; }
  function isOwner()       { return getSession()?.role === 'dono'; }
  function isSuperAdmin()  { return getSession()?.superAdmin === true; }

  // ─── REGISTRO DE EMPRESA ──────────────────────────────────────────
  async function registrarEmpresa({ nomeEmpresa, nomeUsuario, senha, plano = 'free' }) {
    if (!nomeEmpresa?.trim()) throw new Error('Nome da empresa é obrigatório');
    if (!nomeUsuario?.trim()) throw new Error('Nome do usuário é obrigatório');
    if (!senha || senha.length < 4) throw new Error('Senha mínima: 4 caracteres');

    await _ensureDB();

    const empresaId  = _gerarEmpresaId(nomeEmpresa);
    const senhaHash  = await CryptoService.sha256(senha.trim());
    const uid        = Utils.generateId();
    const agora      = Utils.nowISO();

    // Verifica se empresa já existe
    const empSnap = await _fb.getDoc(_fb.doc(_db, 'saas_empresas', empresaId));
    if (empSnap.exists()) throw new Error('Empresa já cadastrada com este nome. Tente outro nome.');

    // Batch: empresa + usuário dono
    const batch = _fb.writeBatch(_db);

    batch.set(_fb.doc(_db, 'saas_empresas', empresaId), {
      id:        empresaId,
      nome:      nomeEmpresa.trim(),
      plano,
      ownerId:   uid,
      ativo:     true,
      criadoEm:  agora,
      vendasMes: 0,
      mesRef:    agora.slice(0, 7),
    });

    batch.set(_fb.doc(_db, 'saas_usuarios', uid), {
      id:        uid,
      empresaId,
      nome:      nomeUsuario.trim(),
      nomeNorm:  nomeUsuario.trim().toLowerCase(),
      senhaHash,
      role:      'dono',
      ativo:     true,
      criadoEm:  agora,
    });

    await batch.commit();

    // Sessão automática após registro
    const sess = { uid, empresaId, nome: nomeUsuario.trim(), role: 'dono', plano, loginAt: Date.now() };
    _saveSession(sess);
    EventBus.emit('saas:login', sess);

    return { empresaId, uid };
  }

  function _gerarEmpresaId(nome) {
    return nome.trim().toLowerCase()
      .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
      .replace(/[^a-z0-9]/g, '_')
      .replace(/_+/g, '_')
      .slice(0, 24) + '_' + Math.random().toString(36).slice(2, 6);
  }

  // ─── LOGIN ────────────────────────────────────────────────────────
  async function login(empresaId, nomeUsuario, senha) {
    if (!empresaId || !nomeUsuario || !senha) throw new Error('Preencha todos os campos');
    await _ensureDB();

    // Verifica empresa
    const empSnap = await _fb.getDoc(_fb.doc(_db, 'saas_empresas', empresaId));
    if (!empSnap.exists()) throw new Error('Empresa não encontrada');
    const empresa = empSnap.data();
    if (!empresa.ativo) throw new Error('Empresa inativa. Contate o suporte.');

    // Busca por empresaId + nomeNorm (2 campos = sem índice composto necessário)
    // Verifica senha em memória para evitar índice composto de 4 campos
    const hash  = await CryptoService.sha256(senha.trim());
    const nomeN = nomeUsuario.trim().toLowerCase();
    const q     = _fb.query(
      _fb.collection(_db, 'saas_usuarios'),
      _fb.where('empresaId', '==', empresaId),
      _fb.where('nomeNorm',  '==', nomeN),
    );
    const snap = await _fb.getDocs(q);
    if (snap.empty) throw new Error('Usuário ou senha incorretos');

    // Filtra por senhaHash e ativo em memória
    const user = snap.docs.map(d => d.data()).find(u => u.ativo && u.senhaHash === hash);
    if (!user) throw new Error('Usuário ou senha incorretos');
    const sess = {
      uid:       user.id,
      empresaId,
      nome:      user.nome,
      role:      user.role,
      plano:     empresa.plano,
      loginAt:   Date.now(),
    };
    _saveSession(sess);
    EventBus.emit('saas:login', sess);
    return sess;
  }

  // Login super-admin (dono do SaaS)
  // Hash fixo cacheado — calculado 1 vez, não a cada login
  let _superHash = null;
  async function loginSuperAdmin(senha, empresaId = null) {
    if (!_superHash) _superHash = await CryptoService.sha256('chgeladas_saas_master_2025');
    const hash = await CryptoService.sha256(senha.trim());
    if (hash !== _superHash) throw new Error('Senha incorreta');

    const sess = { superAdmin: true, nome: 'Super Admin', loginAt: Date.now() };

    // Modo pessoal: carrega contexto de uma empresa específica
    // (mantém superAdmin: true — sem restrições de plano)
    if (empresaId) {
      await _ensureDB();
      const empSnap = await _fb.getDoc(_fb.doc(_db, 'saas_empresas', empresaId));
      if (empSnap.exists()) {
        const emp = empSnap.data();
        sess.empresaId = empresaId;
        sess.plano     = 'enterprise'; // dono da plataforma = enterprise sempre
        sess.nome      = `Admin (${emp.nome})`;
        sess.nomeEmpresa = emp.nome;
      }
    }

    _saveSession(sess);
    return sess;
  }

  /**
   * SuperAdmin entra no contexto de uma empresa específica.
   * Exige que já esteja logado como superAdmin.
   * Mantém superAdmin: true → sem restrições de plano.
   */
  async function enterEmpresa(empresaId) {
    if (!isSuperAdmin()) throw new Error('Apenas o SuperAdmin pode usar esta função');
    await _ensureDB();

    const empSnap = await _fb.getDoc(_fb.doc(_db, 'saas_empresas', empresaId));
    if (!empSnap.exists()) throw new Error('Empresa não encontrada');
    const emp = empSnap.data();

    const sess = {
      ...getSession(),          // mantém superAdmin: true e loginAt
      empresaId,
      plano:       'enterprise',
      nome:        `Admin (${emp.nome})`,
      nomeEmpresa: emp.nome,
    };
    _saveSession(sess);
    EventBus.emit('saas:login', sess);
    return sess;
  }

  function logout() { clearSession(); EventBus.emit('saas:logout'); }

  // ─── CONVITES ─────────────────────────────────────────────────────
  async function gerarConvite(role = 'colaborador') {
    if (!isLogged() || !isOwner()) throw new Error('Apenas o dono pode gerar convites');
    await _ensureDB();

    const empresaId = getEmpresaId();
    const emp = await _fb.getDoc(_fb.doc(_db, 'saas_empresas', empresaId));
    const plano = getPlano(emp.data()?.plano);

    // Verifica limite de usuários
    const usersSnap = await _fb.getDocs(
      _fb.query(_fb.collection(_db, 'saas_usuarios'),
        _fb.where('empresaId', '==', empresaId),
        _fb.where('ativo', '==', true))
    );
    if (usersSnap.size >= plano.maxUsuarios)
      throw new Error(`Plano ${plano.label} permite ${plano.maxUsuarios} usuário(s). Faça upgrade.`);

    const codigo   = Math.random().toString(36).slice(2, 8).toUpperCase();
    const expiraEm = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();

    await _fb.setDoc(_fb.doc(_db, 'saas_convites', codigo), {
      codigo, empresaId, role, expiraEm, usado: false,
      criadoPor: getNome(), criadoEm: Utils.nowISO(),
    });

    return { codigo, expiraEm, role };
  }

  async function usarConvite({ codigo, nome, senha }) {
    if (!codigo || !nome || !senha) throw new Error('Preencha todos os campos');
    if (senha.length < 4) throw new Error('Senha mínima: 4 caracteres');
    await _ensureDB();

    const convSnap = await _fb.getDoc(_fb.doc(_db, 'saas_convites', codigo.toUpperCase()));
    if (!convSnap.exists()) throw new Error('Código inválido');
    const conv = convSnap.data();
    if (conv.usado) throw new Error('Código já utilizado');
    if (new Date(conv.expiraEm) < new Date()) throw new Error('Código expirado');

    // Verifica nome duplicado na empresa
    const nomeN = nome.trim().toLowerCase();
    const dupQ = _fb.query(
      _fb.collection(_db, 'saas_usuarios'),
      _fb.where('empresaId', '==', conv.empresaId),
      _fb.where('nomeNorm',  '==', nomeN),
      _fb.where('ativo',     '==', true),
    );
    const dupSnap = await _fb.getDocs(dupQ);
    if (!dupSnap.empty) throw new Error('Já existe um usuário com este nome nesta empresa. Escolha outro nome.');

    const uid      = Utils.generateId();
    const senhaHash = await CryptoService.sha256(senha.trim());
    const agora    = Utils.nowISO();

    const batch = _fb.writeBatch(_db);

    batch.set(_fb.doc(_db, 'saas_usuarios', uid), {
      id:        uid,
      empresaId: conv.empresaId,
      nome:      nome.trim(),
      nomeNorm:  nome.trim().toLowerCase(),
      senhaHash,
      role:      conv.role,
      ativo:     true,
      criadoEm:  agora,
      conviteCodigo: codigo.toUpperCase(),
    });

    batch.update(_fb.doc(_db, 'saas_convites', codigo.toUpperCase()), {
      usado: true, usadoPor: nome.trim(), usadoEm: agora,
    });

    await batch.commit();

    // Login automático
    const empSnap = await _fb.getDoc(_fb.doc(_db, 'saas_empresas', conv.empresaId));
    const empresa = empSnap.data();
    const sess = {
      uid, empresaId: conv.empresaId, nome: nome.trim(),
      role: conv.role, plano: empresa?.plano || 'free', loginAt: Date.now(),
    };
    _saveSession(sess);
    EventBus.emit('saas:login', sess);
    return sess;
  }

  // ─── USUÁRIOS DA EMPRESA ──────────────────────────────────────────
  async function getUsuariosEmpresa() {
    await _ensureDB();
    const snap = await _fb.getDocs(
      _fb.query(_fb.collection(_db, 'saas_usuarios'),
        _fb.where('empresaId', '==', getEmpresaId()),
        _fb.where('ativo', '==', true))
    );
    return snap.docs.map(d => { const u = d.data(); delete u.senhaHash; return u; });
  }

  async function desativarUsuario(uid) {
    if (!isOwner()) throw new Error('Apenas o dono pode remover usuários');
    await _ensureDB();
    await _fb.updateDoc(_fb.doc(_db, 'saas_usuarios', uid), { ativo: false });
  }

  // ─── BUSCA PÚBLICA DE EMPRESA (para tela de login do cliente) ────
  // Não requer autenticação — busca por nome normalizado
  async function buscarEmpresaPorNome(termo) {
    await _ensureDB();
    const termoNorm = termo.trim().toLowerCase()
      .normalize('NFD').replace(/[\u0300-\u036f]/g, '');

    // Busca por prefixo no nome normalizado (campo nomeNorm, se existir)
    // Fallback: lista todas e filtra em memória (ok para poucos registros)
    const snap = await _fb.getDocs(_fb.collection(_db, 'saas_empresas'));
    const todas = snap.docs.map(d => d.data()).filter(e => e.ativo);

    const resultado = todas.find(e => {
      const nomeNorm = (e.nome || '').toLowerCase()
        .normalize('NFD').replace(/[\u0300-\u036f]/g, '');
      return nomeNorm.includes(termoNorm);
    });

    return resultado || null;
  }

  // Gera convite como super admin (sem verificar isOwner)
  async function gerarConviteAdmin(empresaId, role = 'colaborador') {
    if (!isSuperAdmin()) throw new Error('Acesso negado');
    await _ensureDB();

    const codigo   = Math.random().toString(36).slice(2, 8).toUpperCase();
    const expiraEm = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();

    await _fb.setDoc(_fb.doc(_db, 'saas_convites', codigo), {
      codigo, empresaId, role, expiraEm, usado: false,
      criadoPor: 'Super Admin', criadoEm: Utils.nowISO(),
    });

    return { codigo, expiraEm, role };
  }

  async function listarEmpresas() {
    if (!isSuperAdmin()) throw new Error('Acesso negado');
    await _ensureDB();
    const snap = await _fb.getDocs(_fb.collection(_db, 'saas_empresas'));
    return snap.docs.map(d => d.data()).sort((a, b) => (b.criadoEm||'').localeCompare(a.criadoEm||''));
  }

  async function atualizarPlano(empresaId, plano) {
    if (!isSuperAdmin()) throw new Error('Acesso negado');
    if (!PLANOS[plano]) throw new Error('Plano inválido');
    await _ensureDB();
    await _fb.updateDoc(_fb.doc(_db, 'saas_empresas', empresaId), { plano });
  }

  async function toggleEmpresa(empresaId, ativo) {
    if (!isSuperAdmin()) throw new Error('Acesso negado');
    await _ensureDB();
    await _fb.updateDoc(_fb.doc(_db, 'saas_empresas', empresaId), { ativo });
  }

  // ─── Expor ────────────────────────────────────────────────────────
  window.CH.SaasService = {
    // Sessão
    getSession, isLogged, getEmpresaId, getNome, getRole,
    isOwner, isSuperAdmin, logout,
    // Registro / Login
    registrarEmpresa, login, loginSuperAdmin,
    // Busca pública (login do cliente)
    buscarEmpresaPorNome,
    // Convites
    gerarConvite, usarConvite,
    // Usuários
    getUsuariosEmpresa, desativarUsuario,
    // Super admin
    listarEmpresas, atualizarPlano, toggleEmpresa, gerarConviteAdmin, enterEmpresa,
    // Planos
    getPlanos, getPlano,
  };

  console.info('%c SaasService ✓  (multi-tenant | convites | planos)', 'color:#a78bfa;font-weight:bold');
})();

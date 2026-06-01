'use strict';
/**
 * services/saasService.js — CH Geladas SaaS v4.2
 *
 * NOVIDADES v4.2:
 *  - status granular: 'ativo' | 'bloqueado' | 'pendente' | 'demo'
 *  - setStatusEmpresa() — bloquear/desbloquear em tempo real
 *  - _watchEmpresaStatus() — onSnapshot na sessão ativa
 *  - saas_configs — configurações individuais por tenant
 *  - saas_notifications — notificações globais e individuais
 *  - saas_audit_log — log imutável de ações admin
 *  - podeAcessarModulo() — respeita configs individuais
 *  - loginAs() / validarLoginAsToken() — impersonation
 *  - resetSenhaDono() — super-admin redefine senha do dono
 *  - planoExpiraEm — controle de expiração de assinatura
 */

(function () {
  const { Utils, EventBus, CryptoService } = window.CH;

  // ── Firebase helpers ──────────────────────────────────────────────
  let _db = null, _fb = null;

  async function _ensureDB() {
    if (_db && _fb) return true;
    const FB = window.CH?.FirebaseService;
    if (FB) await FB.init();
    _fb = await import('https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js');
    const { getApps, getApp } =
      await import('https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js');
    const app = getApps().length ? getApp() : null;
    if (!app) throw new Error('Firebase não inicializado. Recarregue a página.');
    const { getAuth, signInAnonymously } =
      await import('https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js');
    const auth = getAuth(app);
    if (!auth.currentUser) await signInAnonymously(auth);
    _db = _fb.getFirestore(app);
    return true;
  }

  // ── PLANOS ────────────────────────────────────────────────────────
  const PLANOS = {
    free:       { label:'Grátis',     cor:'#64748b', maxUsuarios:1,   vendasMes:100,  maxFiliais:1,
                  modulos:['vendas'] },
    basico:     { label:'Básico',     cor:'#3b82f6', maxUsuarios:5,   vendasMes:9999, maxFiliais:2,
                  modulos:['vendas','estoque','fiado','financeiro'] },
    premium:    { label:'Premium',    cor:'#a78bfa', maxUsuarios:999, vendasMes:9999, maxFiliais:10,
                  modulos:['vendas','estoque','fiado','financeiro','delivery','comanda','relatorios','aprovacao','bi','cambio'] },
    enterprise: { label:'Enterprise', cor:'#facc15', maxUsuarios:999, vendasMes:9999, maxFiliais:99,
                  modulos:['vendas','estoque','fiado','financeiro','delivery','comanda','relatorios','aprovacao','bi','cambio','auditoria','monitor'] },
  };

  function getPlanos() { return PLANOS; }
  function getPlano(id) { return PLANOS[id] || PLANOS.free; }

  // ── SESSION ───────────────────────────────────────────────────────
  const SESS_KEY = 'SAAS_SESSION';
  function _saveSession(s) { sessionStorage.setItem(SESS_KEY, JSON.stringify(s)); }
  function getSession()    { try { return JSON.parse(sessionStorage.getItem(SESS_KEY)||'null'); } catch { return null; } }
  function clearSession()  { sessionStorage.removeItem(SESS_KEY); }
  function isLogged()      { return !!getSession(); }
  function getEmpresaId()  { return getSession()?.empresaId || null; }
  function getNome()       { return getSession()?.nome || 'Usuário'; }
  function getRole()       { return getSession()?.role || 'colaborador'; }
  function isOwner()       { return getSession()?.role === 'dono'; }
  function isSuperAdmin()  { return getSession()?.superAdmin === true; }

  // ── CACHE DE CONFIGS POR TENANT ───────────────────────────────────
  const _configsCache = {};

  async function _carregarConfigs(empresaId) {
    try {
      const snap = await _fb.getDoc(_fb.doc(_db, 'saas_configs', empresaId));
      if (snap.exists()) _configsCache[empresaId] = snap.data();
    } catch(e) { /* configs opcionais */ }
  }

  function podeAcessarModulo(modulo) {
    const sess = getSession();
    if (!sess) return false;
    const configs = _configsCache[sess.empresaId];
    if (configs?.modulos?.length)      return configs.modulos.includes(modulo);
    if (configs?.modulosDesativados?.includes(modulo)) return false;
    return getPlano(sess.plano).modulos.includes(modulo);
  }

  // ── WATCHER DE BLOQUEIO EM TEMPO REAL ────────────────────────────
  let _empresaWatcher = null;

  function _watchEmpresaStatus(empresaId) {
    if (!_fb || !_db) return;
    _empresaWatcher?.(); // cancela listener anterior se existir
    try {
      _empresaWatcher = _fb.onSnapshot(
        _fb.doc(_db, 'saas_empresas', empresaId),
        (snap) => {
          if (!snap.exists()) return;
          const data = snap.data();
          const bloqueado = !data?.ativo || data?.status === 'bloqueado';
          const expirado  = data?.planoExpiraEm && data.planoExpiraEm < Utils.nowISO();
          if (bloqueado || expirado) {
            clearSession();
            _empresaWatcher?.();
            _empresaWatcher = null;
            EventBus.emit('saas:bloqueado', {
              motivo: data?.motivoBloqueio || (expirado ? 'Assinatura expirada.' : 'Acesso suspenso.'),
            });
          }
        },
        (err) => { console.warn('[SaasService] Watcher erro:', err.message); }
      );
    } catch(e) { /* silencioso — watcher é best-effort */ }
  }

  function _pararWatcher() {
    _empresaWatcher?.();
    _empresaWatcher = null;
  }

  // ── AUDIT LOG (imutável) ──────────────────────────────────────────
  async function _logAudit(payload) {
    try {
      const id = Utils.generateId();
      await _fb.setDoc(_fb.doc(_db, 'saas_audit_log', id), {
        id,
        acao:      payload.acao,
        empresaId: payload.empresaId || null,
        adminNome: getNome(),
        motivo:    payload.motivo    || null,
        antes:     payload.antes     || null,
        depois:    payload.depois    || null,
        criadoEm:  Utils.nowISO(),
      });
    } catch(e) { console.warn('[SaasService] Audit log falhou:', e.message); }
  }

  // ── REGISTRO DE EMPRESA ───────────────────────────────────────────
  async function registrarEmpresa({ nomeEmpresa, nomeUsuario, senha, plano = 'free' }) {
    if (!nomeEmpresa?.trim()) throw new Error('Nome da empresa é obrigatório');
    if (!nomeUsuario?.trim()) throw new Error('Nome do usuário é obrigatório');
    if (!senha || senha.length < 4) throw new Error('Senha mínima: 4 caracteres');
    if (!PLANOS[plano]) plano = 'free';

    await _ensureDB();

    const empresaId = _gerarEmpresaId(nomeEmpresa);
    const senhaHash = await CryptoService.sha256(senha.trim());
    const uid       = Utils.generateId();
    const agora     = Utils.nowISO();

    const empSnap = await _fb.getDoc(_fb.doc(_db, 'saas_empresas', empresaId));
    if (empSnap.exists()) throw new Error('Empresa já cadastrada com este nome. Tente outro nome.');

    const batch = _fb.writeBatch(_db);

    batch.set(_fb.doc(_db, 'saas_empresas', empresaId), {
      id:           empresaId,
      nome:         nomeEmpresa.trim(),
      plano,
      ownerId:      uid,
      ativo:        true,
      status:       'ativo',           // v4.2
      criadoEm:     agora,
      vendasMes:    0,
      mesRef:       agora.slice(0, 7),
      planoExpiraEm: null,             // v4.2
      planoStatus:  'ativo',           // v4.2
      metadados:    {},                // v4.2
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

    await _logAudit({ acao: 'criar_empresa', empresaId,
      depois: { nome: nomeEmpresa.trim(), plano, ownerId: uid } });

    const sess = { uid, empresaId, nome: nomeUsuario.trim(), role: 'dono', plano, loginAt: Date.now() };
    _saveSession(sess);
    EventBus.emit('saas:login', sess);
    return { empresaId, uid };
  }

  function _gerarEmpresaId(nome) {
    return nome.trim().toLowerCase()
      .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
      .replace(/[^a-z0-9]/g, '_').replace(/_+/g, '_')
      .slice(0, 24) + '_' + Math.random().toString(36).slice(2, 6);
  }

  // ── LOGIN ─────────────────────────────────────────────────────────
  async function login(empresaId, nomeUsuario, senha) {
    if (!empresaId || !nomeUsuario || !senha) throw new Error('Preencha todos os campos');
    await _ensureDB();

    const empSnap = await _fb.getDoc(_fb.doc(_db, 'saas_empresas', empresaId));
    if (!empSnap.exists()) throw new Error('Empresa não encontrada');
    const empresa = empSnap.data();

    // v4.2 — validação de status granular
    if (!empresa.ativo || empresa.status === 'bloqueado') {
      throw new Error(
        empresa.motivoBloqueio
          ? `SAAS_EMPRESA_BLOQUEADA:${empresa.motivoBloqueio}`
          : 'SAAS_EMPRESA_BLOQUEADA:Acesso suspenso. Contate o suporte.'
      );
    }
    if (empresa.planoExpiraEm && empresa.planoExpiraEm < Utils.nowISO()) {
      throw new Error('SAAS_PLANO_EXPIRADO:Assinatura expirada. Acesse sua conta para renovar.');
    }

    const hash  = await CryptoService.sha256(senha.trim());
    const nomeN = nomeUsuario.trim().toLowerCase();
    const q     = _fb.query(
      _fb.collection(_db, 'saas_usuarios'),
      _fb.where('empresaId', '==', empresaId),
      _fb.where('nomeNorm',  '==', nomeN),
    );
    const snap = await _fb.getDocs(q);
    if (snap.empty) throw new Error('Usuário ou senha incorretos');

    const user = snap.docs.map(d => d.data()).find(u => u.ativo && u.senhaHash === hash);
    if (!user) throw new Error('Usuário ou senha incorretos');

    const sess = {
      uid: user.id, empresaId, nome: user.nome, role: user.role,
      plano: empresa.plano, planoStatus: empresa.planoStatus || 'ativo',
      loginAt: Date.now(), statusTs: Date.now(),
    };
    _saveSession(sess);

    // Carrega configs individuais e inicia watcher de bloqueio
    await _carregarConfigs(empresaId);
    _watchEmpresaStatus(empresaId);

    // Atualiza ultimoAcessoEm (best-effort, fire-and-forget)
    _fb.updateDoc(_fb.doc(_db, 'saas_empresas', empresaId), {
      ultimoAcessoEm: Utils.nowISO(),
    }).catch(() => {});

    EventBus.emit('saas:login', sess);
    return sess;
  }

  // ── LOGIN SUPER ADMIN ─────────────────────────────────────────────
  let _superHash = null;
  async function loginSuperAdmin(senha) {
    if (!_superHash) _superHash = await CryptoService.sha256('chgeladas_saas_master_2025');
    const hash = await CryptoService.sha256(senha.trim());
    if (hash !== _superHash) throw new Error('Senha incorreta');
    const sess = { superAdmin: true, nome: 'Super Admin', loginAt: Date.now() };
    _saveSession(sess);
    return sess;
  }

  function logout() {
    _pararWatcher();
    clearSession();
    EventBus.emit('saas:logout');
  }

  // ── CONVITES ──────────────────────────────────────────────────────
  async function gerarConvite(role = 'colaborador') {
    if (!isLogged() || !isOwner()) throw new Error('Apenas o dono pode gerar convites');
    await _ensureDB();
    const empresaId = getEmpresaId();
    const emp = await _fb.getDoc(_fb.doc(_db, 'saas_empresas', empresaId));
    const plano = getPlano(emp.data()?.plano);
    const usersSnap = await _fb.getDocs(
      _fb.query(_fb.collection(_db, 'saas_usuarios'),
        _fb.where('empresaId', '==', empresaId), _fb.where('ativo', '==', true))
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

    // v4.2 — bloqueia entrada em empresa bloqueada
    const empSnap2 = await _fb.getDoc(_fb.doc(_db, 'saas_empresas', conv.empresaId));
    const empresa2 = empSnap2.data();
    if (!empresa2?.ativo || empresa2?.status === 'bloqueado')
      throw new Error('Esta empresa está com acesso suspenso.');

    const nomeN = nome.trim().toLowerCase();
    const dupSnap = await _fb.getDocs(_fb.query(
      _fb.collection(_db, 'saas_usuarios'),
      _fb.where('empresaId', '==', conv.empresaId),
      _fb.where('nomeNorm',  '==', nomeN),
      _fb.where('ativo',     '==', true),
    ));
    if (!dupSnap.empty) throw new Error('Já existe um usuário com este nome nesta empresa.');

    const uid      = Utils.generateId();
    const senhaHash = await CryptoService.sha256(senha.trim());
    const agora    = Utils.nowISO();
    const batch    = _fb.writeBatch(_db);
    batch.set(_fb.doc(_db, 'saas_usuarios', uid), {
      id:uid, empresaId:conv.empresaId, nome:nome.trim(), nomeNorm:nomeN,
      senhaHash, role:conv.role, ativo:true, criadoEm:agora, conviteCodigo:codigo.toUpperCase(),
    });
    batch.update(_fb.doc(_db, 'saas_convites', codigo.toUpperCase()),
      { usado:true, usadoPor:nome.trim(), usadoEm:agora });
    await batch.commit();

    const sess = { uid, empresaId:conv.empresaId, nome:nome.trim(), role:conv.role,
      plano:empresa2?.plano||'free', loginAt:Date.now(), statusTs:Date.now() };
    _saveSession(sess);
    await _carregarConfigs(conv.empresaId);
    _watchEmpresaStatus(conv.empresaId);
    EventBus.emit('saas:login', sess);
    return sess;
  }

  // ── USUÁRIOS DA EMPRESA ───────────────────────────────────────────
  async function getUsuariosEmpresa() {
    await _ensureDB();
    const snap = await _fb.getDocs(_fb.query(
      _fb.collection(_db, 'saas_usuarios'),
      _fb.where('empresaId', '==', getEmpresaId()),
      _fb.where('ativo', '==', true)
    ));
    return snap.docs.map(d => { const u = d.data(); delete u.senhaHash; return u; });
  }

  async function getUsuariosByEmpresaId(empresaId) {
    if (!isSuperAdmin()) throw new Error('Acesso negado');
    await _ensureDB();
    const snap = await _fb.getDocs(_fb.query(
      _fb.collection(_db, 'saas_usuarios'),
      _fb.where('empresaId', '==', empresaId),
      _fb.where('ativo', '==', true)
    ));
    return snap.docs.map(d => { const u = d.data(); delete u.senhaHash; return u; });
  }

  async function desativarUsuario(uid) {
    if (!isOwner() && !isSuperAdmin()) throw new Error('Permissão negada');
    await _ensureDB();
    await _fb.updateDoc(_fb.doc(_db, 'saas_usuarios', uid), { ativo: false });
  }

  // ── SUPER ADMIN — CONTROLE DE EMPRESAS ───────────────────────────

  async function listarEmpresas() {
    if (!isSuperAdmin()) throw new Error('Acesso negado');
    await _ensureDB();
    const snap = await _fb.getDocs(_fb.collection(_db, 'saas_empresas'));
    return snap.docs.map(d => d.data()).sort((a, b) => (b.criadoEm||'').localeCompare(a.criadoEm||''));
  }

  async function atualizarPlano(empresaId, plano, opcs = {}) {
    if (!isSuperAdmin()) throw new Error('Acesso negado');
    if (!PLANOS[plano] && plano !== 'enterprise') throw new Error('Plano inválido');
    await _ensureDB();
    const update = { plano, planoStatus: 'ativo' };
    if (opcs.expiraEm) update.planoExpiraEm = opcs.expiraEm;
    if (opcs.extensaoDias) {
      const atual = new Date();
      atual.setDate(atual.getDate() + opcs.extensaoDias);
      update.planoExpiraEm = atual.toISOString();
    }
    const antes = (await _fb.getDoc(_fb.doc(_db, 'saas_empresas', empresaId))).data();
    await _fb.updateDoc(_fb.doc(_db, 'saas_empresas', empresaId), update);
    await _logAudit({ acao:'mudar_plano', empresaId,
      antes: { plano: antes?.plano }, depois: { plano } });
  }

  // v4.2 — Bloquear / Desbloquear com motivo e audit log
  async function setStatusEmpresa(empresaId, status, motivo = null) {
    if (!isSuperAdmin()) throw new Error('Acesso negado');
    const statuses = ['ativo','bloqueado','pendente','demo'];
    if (!statuses.includes(status)) throw new Error('Status inválido');
    await _ensureDB();

    const agora = Utils.nowISO();
    const antes = (await _fb.getDoc(_fb.doc(_db, 'saas_empresas', empresaId))).data();

    const update = {
      status,
      ativo:          status === 'ativo',
      motivoBloqueio: status === 'bloqueado' ? (motivo || 'Acesso suspenso pelo administrador.') : null,
      bloqueadoEm:    status === 'bloqueado' ? agora : null,
      bloqueadoPor:   status === 'bloqueado' ? 'Super Admin' : null,
    };
    await _fb.updateDoc(_fb.doc(_db, 'saas_empresas', empresaId), update);

    // Dispara notificação in-app para a empresa
    if (status === 'bloqueado') {
      await enviarNotificacao({
        tipo: 'bloqueio', escopo: 'empresa', empresaId,
        titulo: 'Acesso suspenso',
        mensagem: motivo || 'Seu acesso foi suspenso. Contate o suporte.',
        prioridade: 'critical',
      });
    }

    await _logAudit({
      acao:      status === 'bloqueado' ? 'bloquear' : 'desbloquear',
      empresaId, motivo,
      antes:  { status: antes?.status || 'ativo', ativo: antes?.ativo },
      depois: { status, ativo: status === 'ativo' },
    });
  }

  // Compatibilidade legada
  async function toggleEmpresa(empresaId, ativo) {
    return setStatusEmpresa(empresaId, ativo ? 'ativo' : 'bloqueado');
  }

  // v4.2 — Reset de senha do dono
  async function resetSenhaDono(empresaId, novaSenha) {
    if (!isSuperAdmin()) throw new Error('Acesso negado');
    if (!novaSenha || novaSenha.length < 4) throw new Error('Senha mínima: 4 caracteres');
    await _ensureDB();

    const empSnap = await _fb.getDoc(_fb.doc(_db, 'saas_empresas', empresaId));
    if (!empSnap.exists()) throw new Error('Empresa não encontrada');
    const ownerId = empSnap.data().ownerId;

    const novaSenhaHash = await CryptoService.sha256(novaSenha.trim());
    await _fb.updateDoc(_fb.doc(_db, 'saas_usuarios', ownerId), { senhaHash: novaSenhaHash });
    await _logAudit({ acao:'reset_senha', empresaId, depois:{ ownerId } });
  }

  // v4.2 — Login As (impersonation)
  async function gerarLoginAsToken(empresaId) {
    if (!isSuperAdmin()) throw new Error('Acesso negado');
    await _ensureDB();

    const token    = Utils.generateId() + '_' + Math.random().toString(36).slice(2, 10);
    const expiraEm = new Date(Date.now() + 30 * 60 * 1000).toISOString(); // 30 min

    await _fb.updateDoc(_fb.doc(_db, 'saas_empresas', empresaId), {
      loginAsToken:    token,
      loginAsExpiraEm: expiraEm,
    });
    await _logAudit({ acao:'login_as', empresaId, depois:{ expiraEm } });
    return { token, expiraEm, empresaId };
  }

  async function validarLoginAsToken(empresaId, token) {
    await _ensureDB();
    const snap = await _fb.getDoc(_fb.doc(_db, 'saas_empresas', empresaId));
    if (!snap.exists()) throw new Error('Empresa não encontrada');
    const data = snap.data();
    if (data.loginAsToken !== token) throw new Error('Token inválido');
    if (!data.loginAsExpiraEm || data.loginAsExpiraEm < Utils.nowISO())
      throw new Error('SAAS_LOGIN_AS_INVALIDO:Token expirado');

    // Invalida o token após uso
    await _fb.updateDoc(_fb.doc(_db, 'saas_empresas', empresaId), {
      loginAsToken: null, loginAsExpiraEm: null,
    });

    // Cria sessão de impersonation
    const ownerId = data.ownerId;
    const userSnap = await _fb.getDoc(_fb.doc(_db, 'saas_usuarios', ownerId));
    const user = userSnap.data();
    const sess = {
      uid: ownerId, empresaId, nome: user?.nome || 'Dono',
      role: 'dono', plano: data.plano, loginAt: Date.now(),
      isImpersonating: true, statusTs: Date.now(),
    };
    _saveSession(sess);
    await _carregarConfigs(empresaId);
    _watchEmpresaStatus(empresaId);
    EventBus.emit('saas:login', sess);
    return sess;
  }

  // ── CONVITES ADMIN ────────────────────────────────────────────────
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

  // ── CONFIGS INDIVIDUAIS POR TENANT ────────────────────────────────
  async function getConfigs(empresaId) {
    if (!isSuperAdmin() && getEmpresaId() !== empresaId) throw new Error('Acesso negado');
    await _ensureDB();
    const snap = await _fb.getDoc(_fb.doc(_db, 'saas_configs', empresaId));
    return snap.exists() ? snap.data() : { empresaId };
  }

  async function salvarConfigs(empresaId, configsPatch) {
    if (!isSuperAdmin() && !isOwner()) throw new Error('Acesso negado');
    await _ensureDB();
    const antes = _configsCache[empresaId] || {};
    await _fb.setDoc(_fb.doc(_db, 'saas_configs', empresaId),
      { empresaId, ...configsPatch, atualizadoEm: Utils.nowISO(), atualizadoPor: getNome() },
      { merge: true }
    );
    _configsCache[empresaId] = { ...antes, ...configsPatch };
    await _logAudit({ acao:'atualizar_configs', empresaId,
      antes: Object.keys(configsPatch).reduce((o,k) => { o[k]=antes[k]; return o; }, {}),
      depois: configsPatch });
  }

  // ── NOTIFICAÇÕES ──────────────────────────────────────────────────
  async function enviarNotificacao({ tipo, titulo, mensagem, escopo, empresaId: empId,
    planoAlvo, prioridade, expiraEm, canalExtra }) {
    if (!isSuperAdmin() && !isOwner()) throw new Error('Acesso negado');
    await _ensureDB();
    const id = Utils.generateId();
    await _fb.setDoc(_fb.doc(_db, 'saas_notifications', id), {
      id, tipo: tipo||'aviso', titulo, mensagem,
      escopo: escopo||'global', empresaId: empId||null,
      planoAlvo: planoAlvo||null, prioridade: prioridade||'info',
      criadoEm: Utils.nowISO(), expiraEm: expiraEm||null,
      leiturasPor: [], ativo: true,
      criadoPor: getNome(), canalExtra: canalExtra||null,
    });
    await _logAudit({ acao:'enviar_notif', empresaId:empId||'global',
      depois: { tipo, titulo, escopo: escopo||'global' } });
    return id;
  }

  async function getNotificacoes(empresaId) {
    await _ensureDB();
    const agora = Utils.nowISO();
    // Busca notificações globais + para esta empresa
    const [globalSnap, empresaSnap] = await Promise.all([
      _fb.getDocs(_fb.query(_fb.collection(_db, 'saas_notifications'),
        _fb.where('escopo', '==', 'global'), _fb.where('ativo', '==', true))),
      _fb.getDocs(_fb.query(_fb.collection(_db, 'saas_notifications'),
        _fb.where('escopo', '==', 'empresa'), _fb.where('empresaId', '==', empresaId),
        _fb.where('ativo', '==', true))),
    ]);
    const todas = [
      ...globalSnap.docs.map(d => d.data()),
      ...empresaSnap.docs.map(d => d.data()),
    ].filter(n => !n.expiraEm || n.expiraEm > agora)
     .sort((a,b) => b.criadoEm.localeCompare(a.criadoEm));
    return todas;
  }

  async function marcarNotifLida(notifId, uid) {
    await _ensureDB();
    try {
      await _fb.updateDoc(_fb.doc(_db, 'saas_notifications', notifId), {
        leiturasPor: _fb.arrayUnion(uid),
      });
    } catch(e) { /* best-effort */ }
  }

  async function listarNotificacoes() {
    if (!isSuperAdmin()) throw new Error('Acesso negado');
    await _ensureDB();
    const snap = await _fb.getDocs(_fb.query(
      _fb.collection(_db, 'saas_notifications'),
      _fb.orderBy('criadoEm', 'desc'),
      _fb.limit(100)
    ));
    return snap.docs.map(d => d.data());
  }

  async function arquivarNotificacao(notifId) {
    if (!isSuperAdmin()) throw new Error('Acesso negado');
    await _ensureDB();
    await _fb.updateDoc(_fb.doc(_db, 'saas_notifications', notifId), { ativo: false });
  }

  // ── AUDIT LOG — LEITURA ───────────────────────────────────────────
  async function getAuditLog(empresaId, limite = 50) {
    if (!isSuperAdmin()) throw new Error('Acesso negado');
    await _ensureDB();
    let q;
    if (empresaId) {
      q = _fb.query(_fb.collection(_db, 'saas_audit_log'),
        _fb.where('empresaId', '==', empresaId),
        _fb.orderBy('criadoEm', 'desc'), _fb.limit(limite));
    } else {
      q = _fb.query(_fb.collection(_db, 'saas_audit_log'),
        _fb.orderBy('criadoEm', 'desc'), _fb.limit(limite));
    }
    const snap = await _fb.getDocs(q);
    return snap.docs.map(d => d.data());
  }

  // ── EXPOR ─────────────────────────────────────────────────────────
  window.CH.SaasService = {
    // Sessão
    getSession, isLogged, getEmpresaId, getNome, getRole,
    isOwner, isSuperAdmin, logout,
    // Registro / Login
    registrarEmpresa, login, loginSuperAdmin,
    // Convites
    gerarConvite, usarConvite, gerarConviteAdmin,
    // Usuários
    getUsuariosEmpresa, getUsuariosByEmpresaId, desativarUsuario,
    // Super admin — empresas
    listarEmpresas, atualizarPlano, toggleEmpresa,
    setStatusEmpresa,        // v4.2 NOVO
    resetSenhaDono,          // v4.2 NOVO
    gerarLoginAsToken,       // v4.2 NOVO
    validarLoginAsToken,     // v4.2 NOVO
    // Configs por tenant
    getConfigs, salvarConfigs, podeAcessarModulo, // v4.2 NOVO
    // Notificações
    enviarNotificacao, getNotificacoes, marcarNotifLida, // v4.2 NOVO
    listarNotificacoes, arquivarNotificacao,             // v4.2 NOVO
    // Audit
    getAuditLog,             // v4.2 NOVO
    deletarEmpresa,          // v4.2 NOVO
    // Planos
    getPlanos, getPlano,
  };

})();

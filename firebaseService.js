'use strict';
/**
 * services/firebaseService.js — CH Geladas PDV v4.1
 * ─────────────────────────────────────────────────────────────
 * RESPONSABILIDADE ÚNICA: comunicação com o Firebase/Firestore.
 *   init()              → autenticação anônima + inicialização
 *   salvar()            → grava coleção no Firestore
 *   ler()               → lê coleção do Firestore
 *   deletar()           → soft-delete de documentos
 *   atualizar()         → merge de documentos (com adminToken para vendas)
 *   subscribeRealtime() → listeners em tempo real
 *
 * CORREÇÃO v4.1 (CRIT-01):
 *   atualizar('vendas', ...) agora injeta adminToken no payload.
 *   As Firestore Rules v4 exigem adminToken em qualquer update de
 *   /vendas/{id}. Sem isso, toda aprovação era silenciada com
 *   PERMISSION_DENIED engolido pelo catch.
 *
 * PARA CORRIGIR: toque APENAS este arquivo.
 * DEPENDÊNCIAS:  window.CH.{CONSTANTS, Utils, EventBus, Store}
 */
(function () {
  const { CONSTANTS, Utils, EventBus } = window.CH;

  const FirebaseService = (() => {
    const CONFIG = {
      apiKey:            'AIzaSyCPq8-B4l-kThTXtX9CVBTdpzarBObUYxI',
      authDomain:        'ch-geladas.firebaseapp.com',
      projectId:         'ch-geladas',
      storageBucket:     'ch-geladas.firebasestorage.app',
      messagingSenderId: '859746983655',
      appId:             '1:859746983655:web:dce025d5048850923a8c42',
    };

    let _db=null, _auth=null, _fb=null;
    let _ready=false, _adminToken=null;
    let _unsubscribers=[];

    // ── Token helper ─────────────────────────────────────────────────
    /**
     * Retorna o adminToken disponível, priorizando:
     *   1. Variável em memória (_adminToken)
     *   2. sessionStorage['CH_ADMIN_TOKEN']
     *   3. localStorage['CH_CONFIG'].session.adminToken
     *
     * Necessário porque atualizar() pode ser chamado pelo SyncQueue
     * em contexto onde a sessão já foi estabelecida mas _adminToken
     * ainda não foi carregado na memória do serviço.
     */
    function _resolveAdminToken() {
      if (_adminToken) return _adminToken;
      const sess = sessionStorage.getItem('CH_ADMIN_TOKEN');
      if (sess) { _adminToken = sess; return _adminToken; }
      try {
        const cfg = JSON.parse(localStorage.getItem('CH_CONFIG') || '{}');
        const tok = cfg?.session?.adminToken || cfg?.adminToken || null;
        if (tok) { _adminToken = tok; return _adminToken; }
      } catch (_) {}
      return null;
    }

    // ── Init ─────────────────────────────────────────────────────────
    async function init() {
      if (_ready) return true;
      if (!CONFIG.apiKey) return false;
      try {
        const { initializeApp, getApps, getApp } =
          await import('https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js');
        _fb   = await import('https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js');
        const auth = await import('https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js');

        const app = getApps().length ? getApp() : initializeApp(CONFIG);
        _db   = _fb.getFirestore(app);
        _auth = auth.getAuth(app);

        if (!_auth.currentUser) {
          await auth.signInAnonymously(_auth);
        }
        _ready = true;

        // Carrega token da sessão persistida
        _resolveAdminToken();

        EventBus.emit('firebase:ready');
        _subscribeRealtime();
        return true;
      } catch (e) {
        console.warn('[Firebase] Falha na inicialização:', e.message);
        return false;
      }
    }

    // ── Realtime listeners ────────────────────────────────────────────
    function _subscribeRealtime() {
      _unsubscribers.forEach(fn => { try { fn(); } catch (_) {} });
      _unsubscribers = [];
      const role = window.CH?.AuthService?.getRole?.() ?? null;
      if (!role || !_db || !_fb) return;

      const Store = window.CH.Store;

      const colsRT = (['admin', 'adm'].includes(role))
        ? ['estoque', 'config', 'fiado', 'comandas', 'pedidos', 'saidas', 'financeiro', 'usuarios']
        : ['estoque', 'config', 'usuarios'];

      // Listener vendas — apenas hoje para reduzir custo de leitura.
      // FALLBACK: se o índice composto ainda estiver sendo construído no Firestore
      // (FAILED_PRECONDITION), cai para query simples sem filtro de data.
      // O índice leva ~2min para ficar pronto após o primeiro deploy.
      try {
        const hoje = new Date().toISOString().slice(0, 10);

        function _onVendasSnap(snap) {
          const vendas = snap.docs
            .map(d => ({ ...d.data(), _fbSynced: true }))
            .filter(v => !v._deleted);
          try { localStorage.setItem(CONSTANTS.DB.VENDAS, JSON.stringify(vendas)); } catch (_) {}
          Store?.invalidate('vendas');
          EventBus.emit('store:updated', 'vendas');
          EventBus.emit('store:vendas');
          EventBus.emit('sync:ok', 'vendas');
        }

        // Query otimizada (requer índice composto dataCurta+criadoEm)
        const qOtimizada = _fb.query(
          _fb.collection(_db, 'vendas'),
          _fb.where('dataCurta', '>=', hoje),
          _fb.orderBy('dataCurta', 'desc'),
          _fb.orderBy('criadoEm', 'desc'),
          _fb.limit(500)
        );

        const unsub = _fb.onSnapshot(qOtimizada, _onVendasSnap, err => {
          if (err.code === 'failed-precondition') {
            // Índice ainda construindo — usa query simples como fallback
            console.warn('[RT] vendas: índice composto pendente, usando fallback sem filtro de data.');
            const qFallback = _fb.query(
              _fb.collection(_db, 'vendas'),
              _fb.orderBy('criadoEm', 'desc'),
              _fb.limit(300)
            );
            const unsubFallback = _fb.onSnapshot(qFallback, _onVendasSnap,
              err2 => console.warn('[RT] vendas fallback:', err2.code)
            );
            _unsubscribers.push(unsubFallback);
          } else {
            console.warn('[RT] vendas:', err.code);
          }
        });
        _unsubscribers.push(unsub);
      } catch (e) { console.warn('[RT] vendas subscribe falhou:', e.message); }

      colsRT.forEach(col => {
        try {
          const unsub = _fb.onSnapshot(_fb.doc(_db, 'ch_dados', col), snap => {
            if (!snap.exists()) return;
            const dados = snap.data()?.dados;
            if (!dados) return;
            if (col === 'usuarios') {
              if (Array.isArray(dados)) {
                try { localStorage.setItem('CH_USERS', JSON.stringify(dados)); } catch (_) {}
                EventBus.emit('usuarios:atualizados', dados);
              }
              return;
            }
            const key = CONSTANTS.DB[col.toUpperCase()];
            if (!key) return;
            try { localStorage.setItem(key, JSON.stringify(dados)); } catch (_) {}
            Store?.invalidate(col);
            EventBus.emit('store:updated', col);
            EventBus.emit(`store:${col}`);
            EventBus.emit('sync:ok', col);
          }, err => console.warn('[RT]', col, err.code));
          _unsubscribers.push(unsub);
        } catch (e) { console.warn('[RT] subscribe falhou:', col, e.message); }
      });
    }

    // ── Admin token ───────────────────────────────────────────────────
    async function gerarAdminToken(pin) {
      if (!_auth?.currentUser) return null;
      const uid = _auth.currentUser.uid;
      const raw = `${uid}:${pin}:ch_geladas_admin`;
      const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(raw));
      _adminToken = Array.from(new Uint8Array(buf))
        .map(b => b.toString(16).padStart(2, '0')).join('');
      sessionStorage.setItem('CH_ADMIN_TOKEN', _adminToken);
      return _adminToken;
    }

    // ── Salvar ────────────────────────────────────────────────────────
    async function salvar(colName, dados) {
      if (!_ready || !_db || !_fb) return false;
      try {
        if (colName === 'vendas') {
          const pendentes = Array.isArray(dados)
            ? dados.filter(v => v?.id && !v._fbSynced).slice(0, 50)
            : [];
          if (!pendentes.length) return true;
          const batch = _fb.writeBatch(_db);
          pendentes.forEach(v => {
            const ref = _fb.doc(_db, 'vendas', v.id);
            batch.set(ref, { ...v, _fbSynced: true, syncedAt: Utils.nowISO() });
          });
          await batch.commit();
          const key = CONSTANTS.DB.VENDAS;
          try {
            const vl  = JSON.parse(localStorage.getItem(key) || '[]');
            const ids = new Set(pendentes.map(v => v.id));
            vl.forEach(v => { if (ids.has(v.id)) v._fbSynced = true; });
            localStorage.setItem(key, JSON.stringify(vl));
            window.CH.Store?.invalidate('vendas');
          } catch (_) {}
        } else {
          const _semAdminToken = new Set(['comandas', 'fiado', 'cambio']);
          const tok = _resolveAdminToken();
          const docData = { dados, ts: Utils.nowISO() };
          if (tok && !_semAdminToken.has(colName)) docData.adminToken = tok;
          await _fb.setDoc(_fb.doc(_db, 'ch_dados', colName), docData);
        }
        return true;
      } catch (e) {
        console.warn('[Firebase] Salvar falhou:', colName, e.code || e.message);
        return false;
      }
    }

    // ── Deletar ───────────────────────────────────────────────────────
    async function deletar(colName, dados) {
      if (!_ready || !_db || !_fb) return false;
      try {
        if (colName === 'vendas') {
          const ids  = Array.isArray(dados) ? dados : [dados];
          const tok  = _resolveAdminToken();
          const batch = _fb.writeBatch(_db);
          ids.forEach(id => {
            const ref = _fb.doc(_db, 'vendas', typeof id === 'string' ? id : id.id);
            const d   = { _deleted: true, _fbSynced: true, updatedAt: Utils.nowISO() };
            if (tok) d.adminToken = tok;
            batch.set(ref, d, { merge: true });
          });
          await batch.commit();
        }
        return true;
      } catch (e) {
        console.warn('[Firebase] Deletar falhou:', colName, e.code || e.message);
        return false;
      }
    }

    // ── Atualizar ─────────────────────────────────────────────────────
    /**
     * CORREÇÃO CRIT-01:
     * Firestore Rules v4 exigem adminToken em qualquer update de /vendas/{id}.
     * Esta função agora injeta o token resolvido no payload antes do commit.
     * Sem ele, aprovacaoService → SyncQueue → atualizar() falhava com
     * PERMISSION_DENIED silencioso — aprovações nunca sincronizavam.
     */
    async function atualizar(colName, dados) {
      if (!_ready || !_db || !_fb) return false;

      try {
        if (colName === 'vendas') {
          const itens = Array.isArray(dados) ? dados : [dados];
          const tok   = _resolveAdminToken();

          if (!tok) {
            // Sem token: não pode atualizar vendas pelas Rules v4.
            // Registra erro com contexto suficiente para diagnóstico.
            console.error(
              '[Firebase] atualizar(vendas): adminToken ausente na sessão. ' +
              'Updates de vendas exigem autenticação admin (Rules v4). ' +
              'IDs afetados: ' + itens.map(v => v.id).join(', ')
            );
            EventBus.emit('sync:error', {
              colecao:   'vendas',
              motivo:    'adminToken ausente',
              tentativa: 1,
            });
            return false;
          }

          const batch = _fb.writeBatch(_db);
          itens.forEach(v => {
            const ref = _fb.doc(_db, 'vendas', v.id);
            batch.set(
              ref,
              {
                ...v,
                adminToken: tok,        // ← obrigatório pelas Rules v4
                _fbSynced:  true,
                updatedAt:  Utils.nowISO(),
              },
              { merge: true }
            );
          });
          await batch.commit();
          return true;
        }

        // Outras coleções (sem restrição de adminToken nas Rules v4)
        const itens = Array.isArray(dados) ? dados : [dados];
        const batch = _fb.writeBatch(_db);
        itens.forEach(item => {
          if (!item?.id) return;
          const ref = _fb.doc(_db, colName, item.id);
          batch.set(ref, { ...item, _fbSynced: true, updatedAt: Utils.nowISO() }, { merge: true });
        });
        await batch.commit();
        return true;

      } catch (e) {
        console.error(
          `[Firebase] atualizar falhou | col=${colName} | code=${e.code} | msg=${e.message}`
        );
        return false;
      }
    }

    // ── Ler ───────────────────────────────────────────────────────────
    async function ler(colName) {
      if (!_ready || !_db || !_fb) return null;
      try {
        if (colName === 'vendas') {
          const snap = await _fb.getDocs(_fb.query(
            _fb.collection(_db, 'vendas'),
            _fb.orderBy('criadoEm', 'desc'),
            _fb.limit(1000)
          ));
          return snap.docs.map(d => ({ ...d.data(), _fbSynced: true })).filter(v => !v._deleted);
        } else {
          const snap = await _fb.getDoc(_fb.doc(_db, 'ch_dados', colName));
          return snap.exists() ? snap.data().dados : null;
        }
      } catch (e) {
        console.warn('[Firebase] Ler falhou:', colName, e.code || e.message);
        return null;
      }
    }

    function _req() {
      if (!_ready || !_db || !_fb) throw new Error('Firebase não inicializado.');
    }

    // ── API pública ───────────────────────────────────────────────────
    return {
      init, salvar, ler, deletar, atualizar,
      isReady:           () => _ready,
      getUID:            () => _auth?.currentUser?.uid || null,
      getConfig:         () => ({ ...CONFIG }),
      setConfig(c)       { Object.assign(CONFIG, c); window.CH.Store?.mutateConfig(cfg => { cfg.firebase = { ...c }; }); },
      gerarAdminToken,
      getAdminToken:     () => _resolveAdminToken(),
      clearAdminToken:   () => { _adminToken = null; sessionStorage.removeItem('CH_ADMIN_TOKEN'); },
      subscribeRealtime: _subscribeRealtime,
      runTransaction(fn) { _req(); return _fb.runTransaction(_db, fn); },
      docRef(colPath, docId) { _req(); return docId ? _fb.doc(_db, colPath, docId) : _fb.doc(_db, colPath); },
      colRef(colPath)    { _req(); return _fb.collection(_db, colPath); },
      newDocRef(colPath) { _req(); return _fb.doc(_fb.collection(_db, colPath)); },
      getBatch()         { _req(); return _fb.writeBatch(_db); },
      serverTimestamp()  { _req(); return _fb.serverTimestamp(); },
    };
  })();

  window.CH.FirebaseService = FirebaseService;
  console.info('%c FirebaseService ✓  v4.1 (CRIT-01 corrigido | adminToken em atualizar)', 'color:#10b981;font-weight:bold');
})();

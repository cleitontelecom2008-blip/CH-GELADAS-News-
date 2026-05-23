'use strict';
/**
 * services/firebaseService.js — CH Geladas PDV
 * ─────────────────────────────────────────────────────────────
 * RESPONSABILIDADE ÚNICA: comunicação com o Firebase/Firestore.
 *   init()           → autenticação anônima + inicialização
 *   salvar()         → grava coleção no Firestore
 *   ler()            → lê coleção do Firestore
 *   deletar()        → soft-delete de documentos
 *   atualizar()      → merge de documentos
 *   subscribeRealtime() → listeners em tempo real
 *
 * PARA CORRIGIR: toque APENAS este arquivo.
 * DEPENDÊNCIAS:  window.CH.{CONSTANTS, Utils, EventBus, Store}
 */
(function () {
  const { CONSTANTS, Utils, EventBus } = window.CH;

  const FirebaseService = (() => {
    const CONFIG = {
      apiKey:            'AIzaSyDdFvTRQQmomMiLD0byrBwGZnitSC0zwus',
      authDomain:        'new-ch-geladas.firebaseapp.com',
      projectId:         'new-ch-geladas',
      storageBucket:     'new-ch-geladas.firebasestorage.app',
      messagingSenderId: '898297448757',
      appId:             '1:898297448757:web:d59cb5336d61d19ad9a47c',
      measurementId:     'G-QYJRW9YEPW',
    };

    let _db=null, _auth=null, _fb=null;
    let _ready=false, _adminToken=null;
    let _unsubscribers=[];

    async function init() {
      if (_ready) return true;
      if (!CONFIG.apiKey) { return false; }
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

        if (!_adminToken) {
          const saved = sessionStorage.getItem('CH_ADMIN_TOKEN');
          if (saved) { _adminToken=saved; }
        }

        EventBus.emit('firebase:ready');
        _subscribeRealtime();
        return true;
      } catch(e) { console.warn('[Firebase] Falha:', e.message); return false; }
    }

    function _subscribeRealtime() {
      _unsubscribers.forEach(fn=>{try{fn();}catch(_){}});
      _unsubscribers=[];
      const role = window.CH?.AuthService?.getRole?.()??null;
      if (!role||!_db||!_fb) return;

      const Store = window.CH.Store;

      const colsRT = (['admin','adm'].includes(role))
        ? ['estoque','config','fiado','comandas','pedidos','saidas','financeiro','usuarios']
        : ['estoque','config','usuarios'];

      // Listener vendas em tempo real
      try {
        const q = _fb.query(_fb.collection(_db,'vendas'),_fb.orderBy('criadoEm','desc'),_fb.limit(1000));
        const unsub = _fb.onSnapshot(q, snap=>{
          const vendas=snap.docs.map(d=>({...d.data(),_fbSynced:true})).filter(v=>!v._deleted);
          try{localStorage.setItem(CONSTANTS.DB.VENDAS,JSON.stringify(vendas));}catch(_){}
          Store?.invalidate('vendas');
          EventBus.emit('store:updated','vendas');
          EventBus.emit('store:vendas');
          EventBus.emit('sync:ok','vendas');
        }, err=>console.warn('[RT] vendas:',err.code));
        _unsubscribers.push(unsub);
      } catch(e){console.warn('[RT] vendas subscribe falhou:',e.message);}

      colsRT.forEach(col=>{
        try {
          const unsub = _fb.onSnapshot(_fb.doc(_db,'ch_dados',col), snap=>{
            if (!snap.exists()) return;
            const dados=snap.data()?.dados;
            if (!dados) return;
            if (col==='usuarios') {
              if (Array.isArray(dados)) {
                try{localStorage.setItem('CH_USERS',JSON.stringify(dados));}catch(_){}
                EventBus.emit('usuarios:atualizados',dados);
              }
              return;
            }
            const key=CONSTANTS.DB[col.toUpperCase()];
            if (!key) return;
            try{localStorage.setItem(key,JSON.stringify(dados));}catch(_){}
            Store?.invalidate(col);
            EventBus.emit('store:updated',col);
            EventBus.emit(`store:${col}`);
            EventBus.emit('sync:ok',col);
          }, err=>console.warn('[RT]',col,err.code));
          _unsubscribers.push(unsub);
        } catch(e){console.warn('[RT] subscribe falhou:',col,e.message);}
      });
    }

    async function gerarAdminToken(pin) {
      if (!_auth?.currentUser) return null;
      const uid=_auth.currentUser.uid;
      const raw=`${uid}:${pin}:ch_geladas_admin`;
      const buf=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(raw));
      _adminToken=Array.from(new Uint8Array(buf)).map(b=>b.toString(16).padStart(2,'0')).join('');
      sessionStorage.setItem('CH_ADMIN_TOKEN',_adminToken);
      return _adminToken;
    }

    async function salvar(colName, dados) {
      if (!_ready||!_db||!_fb) return false;
      try {
        if (colName==='vendas') {
          const pendentes=Array.isArray(dados)?dados.filter(v=>v?.id&&!v._fbSynced).slice(0,50):[];
          if (!pendentes.length) return true;
          const batch=_fb.writeBatch(_db);
          pendentes.forEach(v=>{const ref=_fb.doc(_db,'vendas',v.id);batch.set(ref,{...v,_fbSynced:true,syncedAt:Utils.nowISO()});});
          await batch.commit();
          const key=CONSTANTS.DB.VENDAS;
          try{
            const vl=JSON.parse(localStorage.getItem(key)||'[]');
            const ids=new Set(pendentes.map(v=>v.id));
            vl.forEach(v=>{if(ids.has(v.id))v._fbSynced=true;});
            localStorage.setItem(key,JSON.stringify(vl));
            window.CH.Store?.invalidate('vendas');
          }catch(_){}
        } else {
          const _semAdminToken=new Set(['comandas','fiado','cambio']);
          const docData={dados,ts:Utils.nowISO()};
          if (_adminToken&&!_semAdminToken.has(colName)) docData.adminToken=_adminToken;
          await _fb.setDoc(_fb.doc(_db,'ch_dados',colName),docData);
        }
        return true;
      } catch(e){console.warn('[Firebase] Salvar falhou:',colName,e.code||e.message);return false;}
    }

    async function deletar(colName, dados) {
      if (!_ready||!_db||!_fb) return false;
      try {
        if (colName==='vendas') {
          const ids=Array.isArray(dados)?dados:[dados];
          const batch=_fb.writeBatch(_db);
          ids.forEach(id=>{
            const ref=_fb.doc(_db,'vendas',typeof id==='string'?id:id.id);
            const d={_deleted:true,_fbSynced:true,updatedAt:Utils.nowISO()};
            if(_adminToken) d.adminToken=_adminToken;
            batch.set(ref,d,{merge:true});
          });
          await batch.commit();
        }
        return true;
      } catch(e){console.warn('[Firebase] Deletar falhou:',colName,e.code||e.message);return false;}
    }

    async function atualizar(colName, dados) {
      if (!_ready||!_db||!_fb) return false;
      try {
        if (colName==='vendas') {
          const itens=Array.isArray(dados)?dados:[dados];
          const batch=_fb.writeBatch(_db);
          itens.forEach(v=>{const ref=_fb.doc(_db,'vendas',v.id);batch.set(ref,{...v,_fbSynced:true,updatedAt:Utils.nowISO()},{merge:true});});
          await batch.commit();
        }
        return true;
      } catch(e){console.warn('[Firebase] Atualizar falhou:',colName,e.code||e.message);return false;}
    }

    async function ler(colName) {
      if (!_ready||!_db||!_fb) return null;
      try {
        if (colName==='vendas') {
          const snap=await _fb.getDocs(_fb.query(_fb.collection(_db,'vendas'),_fb.orderBy('criadoEm','desc'),_fb.limit(1000)));
          return snap.docs.map(d=>({...d.data(),_fbSynced:true})).filter(v=>!v._deleted);
        } else {
          const snap=await _fb.getDoc(_fb.doc(_db,'ch_dados',colName));
          return snap.exists()?snap.data().dados:null;
        }
      } catch(e){console.warn('[Firebase] Ler falhou:',colName,e.code||e.message);return null;}
    }

    function _req() { if(!_ready||!_db||!_fb) throw new Error('Firebase não inicializado.'); }

    return {
      init, salvar, ler, deletar, atualizar,
      isReady:           () => _ready,
      getUID:            () => _auth?.currentUser?.uid||null,
      getConfig:         () => ({...CONFIG}),
      setConfig(c)       { Object.assign(CONFIG,c); window.CH.Store?.mutateConfig(cfg=>{cfg.firebase={...c};}); },
      gerarAdminToken,
      getAdminToken:     () => _adminToken,
      clearAdminToken:   () => { _adminToken=null; sessionStorage.removeItem('CH_ADMIN_TOKEN'); },
      subscribeRealtime: _subscribeRealtime,
      runTransaction(fn) { _req(); return _fb.runTransaction(_db,fn); },
      docRef(colPath,docId) { _req(); return docId?_fb.doc(_db,colPath,docId):_fb.doc(_db,colPath); },
      colRef(colPath)    { _req(); return _fb.collection(_db,colPath); },
      newDocRef(colPath) { _req(); return _fb.doc(_fb.collection(_db,colPath)); },
      getBatch()         { _req(); return _fb.writeBatch(_db); },
      serverTimestamp()  { _req(); return _fb.serverTimestamp(); },
    };
  })();

  window.CH.FirebaseService = FirebaseService;
})();

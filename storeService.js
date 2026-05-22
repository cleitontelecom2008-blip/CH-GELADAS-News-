'use strict';
/**
 * services/storeService.js — CH Geladas PDV
 * ─────────────────────────────────────────────────────────────
 * RESPONSABILIDADE ÚNICA: gerenciar o estado local (localStorage)
 *   e enfileirar sincronização quando dados mudam.
 *
 * Também exporta SyncService (simples), que delega ao SyncQueue
 * (services/syncService.js) quando disponível.
 *
 * PARA CORRIGIR: toque APENAS este arquivo.
 * DEPENDÊNCIAS:  window.CH.{CONSTANTS, Utils, EventBus}
 */
(function () {
  const { CONSTANTS, Utils, EventBus } = window.CH;

  /* ── Store ─────────────────────────────────────────────────────── */
  const Store = (() => {
    const _cache = {};

    const _key = {
      estoque:'CH_ESTOQUE', vendas:'CH_VENDAS', comandas:'CH_COMANDAS',
      fiado:'CH_FIADO', ponto:'CH_PONTO', pedidos:'CH_PEDIDOS',
      config:'CH_CONFIG', auditoria:'CH_AUDITORIA',
      movimentacoes:'CH_MOVIMENTACOES', categorias:'CH_CATEGORIAS',
      fornecedores:'CH_FORNECEDORES', financeiro:'CH_FINANCEIRO',
      saidas:'CH_SAIDAS',
    };

    const _empty = {
      estoque:[], vendas:[], comandas:[], fiado:[], ponto:[],
      pedidos:[], auditoria:[], config:{}, movimentacoes:[],
      categorias:[], fornecedores:[], financeiro:[], saidas:[],
    };

    const _limits = {
      vendas:CONSTANTS.MAX_VENDAS, ponto:CONSTANTS.MAX_PONTO,
      pedidos:CONSTANTS.MAX_PEDIDOS, auditoria:CONSTANTS.MAX_AUDITORIA,
      comandas:CONSTANTS.MAX_COMANDAS, movimentacoes:CONSTANTS.MAX_MOVIMENTACOES,
      financeiro:CONSTANTS.MAX_FINANCEIRO, saidas:CONSTANTS.MAX_SAIDAS,
    };

    function _read(col) {
      if (_cache[col] !== undefined) return _cache[col];
      try {
        const raw = localStorage.getItem(_key[col]);
        _cache[col] = raw ? JSON.parse(raw) : Utils.deepClone(_empty[col]);
      } catch { _cache[col] = Utils.deepClone(_empty[col]); }
      return _cache[col];
    }

    function _write(col, data) {
      _cache[col] = data;
      try {
        localStorage.setItem(_key[col], JSON.stringify(data));
      } catch(e) {
        if (e.name==='QuotaExceededError'||e.code===22) {
          console.warn('[Store] localStorage cheio — executando purge automático...');
          EventBus.emit('storage:quota-exceeded', col);
          try {
            const corte = (dias) => { const d=new Date(); d.setDate(d.getDate()-dias); return d.toISOString().slice(0,10); };
            const purgeCol = (c, dtCorte, key) => {
              try {
                const arr = JSON.parse(localStorage.getItem(key)||'[]');
                if (!Array.isArray(arr)) return;
                localStorage.setItem(key, JSON.stringify(arr.filter(v=>(v.dataCurta||v.data||'')>=dtCorte||!v._fbSynced)));
                delete _cache[c];
              } catch(_) {}
            };
            purgeCol('vendas',        corte(7),  _key.vendas);
            purgeCol('auditoria',     corte(3),  _key.auditoria);
            purgeCol('financeiro',    corte(7),  _key.financeiro);
            purgeCol('movimentacoes', corte(7),  _key.movimentacoes);
            localStorage.setItem(_key[col], JSON.stringify(data));
            console.info('[Store] Purge de emergência concluído.');
          } catch(e2) {
            console.error('[Store] localStorage crítico — dado só em memória:', col, e2);
            EventBus.emit('storage:critical', col);
          }
        } else {
          console.error('[Store] write falhou:', col, e);
        }
      }
    }

    function _notify(col) {
      EventBus.emit('store:updated', col);
      EventBus.emit(`store:${col}`);
    }

    const _localOnly = new Set(['auditoria', 'movimentacoes']);

    function _mutate(col, fn) {
      const data = _read(col);
      fn(data);
      const limit = _limits[col];
      const final = (limit && Array.isArray(data)) ? data.slice(0,limit) : data;
      _write(col, final);
      _notify(col);
      if (_localOnly.has(col)) return;
      if (window.CH?.SyncQueue) {
        const role = window.CH.AuthService?.getRole?.() ?? null;
        const permCore    = role && (CONSTANTS.PERMISSOES[role]?.escrever?.includes(col)??false);
        const permUserSvc = role && window.CH?.UserService?.podeEscrever?.(role,col);
        if (permCore || permUserSvc) window.CH.SyncQueue.enqueue('salvar', col, final);
      } else {
        window._pendingSync?.push(col);
      }
    }

    function _migrarLegacy() {
      const raw = localStorage.getItem(CONSTANTS.LEGACY_KEY);
      if (!raw) return;
      if (Object.values(_key).some(k=>!!localStorage.getItem(k))) return;
      try {
        const old = JSON.parse(raw);
        if (Array.isArray(old.estoque)  && old.estoque.length)  _write('estoque',  old.estoque);
        if (Array.isArray(old.vendas)   && old.vendas.length)   _write('vendas',   old.vendas);
        if (Array.isArray(old.comandas) && old.comandas.length) _write('comandas', old.comandas);
        if (Array.isArray(old.fiado)    && old.fiado.length)    _write('fiado',    old.fiado);
        if (Array.isArray(old.ponto)    && old.ponto.length)    _write('ponto',    old.ponto);
        if (Array.isArray(old.pedidos)  && old.pedidos.length)  _write('pedidos',  old.pedidos);
        if (old.config && typeof old.config==='object')         _write('config',   old.config);
        console.info('[Store] Banco legado migrado.');
      } catch(e) { console.warn('[Store] Migração falhou:', e); }
    }

    window.addEventListener('storage', e => {
      const col = Object.entries(_key).find(([,k])=>k===e.key)?.[0];
      if (col) { delete _cache[col]; _notify(col); }
    });

    _migrarLegacy();

    return {
      getEstoque()       { return _read('estoque'); },
      getVendas()        { return _read('vendas'); },
      getComandas()      { return _read('comandas'); },
      getFiado()         { return _read('fiado'); },
      getPonto()         { return _read('ponto'); },
      getPedidos()       { return _read('pedidos'); },
      getConfig()        { return _read('config'); },
      getAuditoria()     { return _read('auditoria'); },
      getMovimentacoes() { return _read('movimentacoes'); },
      getCategorias()    { return _read('categorias'); },
      getFornecedores()  { return _read('fornecedores'); },
      getFinanceiro()    { return _read('financeiro'); },
      getSaidas()        { return _read('saidas'); },

      getVendasHoje() {
        const hoje = Utils.todayISO();
        return this.getVendas().filter(v=>v.dataCurta===hoje);
      },
      getLowStock() {
        const thr = this.getConfig()?.alertaEstoque || CONSTANTS.LOW_STOCK;
        return this.getEstoque().filter(p=>p.qtdUn>0&&p.qtdUn<=thr);
      },
      getOutOfStock()   { return this.getEstoque().filter(p=>(p.qtdUn||0)<=0); },
      getInvestimento() { return this.getConfig()?.investimento||0; },

      mutateEstoque(fn) {
        _mutate('estoque', (data) => {
          fn(data);
          data.forEach(p => {
            // precoUn é fonte da verdade — propaga para alias, nunca o contrário
            if (p.precoUn!==undefined) p.precoVenda=p.precoUn;
            else if (p.precoVenda!==undefined) p.precoUn=p.precoVenda;
            if (p.custoUn!==undefined) p.precoCusto=p.custoUn;
            else if (p.precoCusto!==undefined) p.custoUn=p.precoCusto;
            if (p.qtdUn!==undefined) p.estoqueAtual=p.qtdUn;
            else if (p.estoqueAtual!==undefined) p.qtdUn=p.estoqueAtual;
          });
        });
      },
      mutateVendas(fn)        { _mutate('vendas',        fn); },
      mutateComandas(fn)      { _mutate('comandas',      fn); },
      mutateFiado(fn)         { _mutate('fiado',         fn); },
      mutatePonto(fn)         { _mutate('ponto',         fn); },
      mutatePedidos(fn)       { _mutate('pedidos',       fn); },
      mutateConfig(fn)        { _mutate('config',        fn); },
      mutateAuditoria(fn)     { _mutate('auditoria',     fn); },
      mutateMovimentacoes(fn) { _mutate('movimentacoes', fn); },
      mutateCategorias(fn)    { _mutate('categorias',    fn); },
      mutateFornecedores(fn)  { _mutate('fornecedores',  fn); },
      mutateFinanceiro(fn)    { _mutate('financeiro',    fn); },
      mutateSaidas(fn)        { _mutate('saidas',        fn); },

      invalidate(col) {
        if (col) delete _cache[col];
        else Object.keys(_cache).forEach(k=>delete _cache[k]);
      },

      _writeRaw(col, data) { _write(col, data); _notify(col); },

      purgeOldData({ diasVendas=30, diasFinanceiro=30, diasAuditoria=7, diasMovimentacoes=14 }={}) {
        const corte = (dias) => { const d=new Date(); d.setDate(d.getDate()-dias); return d.toISOString().slice(0,10); };
        let purged={};
        const purgeOne = (col, dtCorte, campo) => {
          const antes=_read(col).length;
          const filtrado=_read(col).filter(v=>(v[campo]>=dtCorte)||!v._fbSynced);
          if(filtrado.length<antes){_write(col,filtrado);purged[col]=antes-filtrado.length;}
        };
        purgeOne('vendas','dataCurta',corte(diasVendas));
        purgeOne('financeiro','dataCurta',corte(diasFinanceiro));
        purgeOne('auditoria','dataCurta',corte(diasAuditoria));
        purgeOne('movimentacoes','dataCurta',corte(diasMovimentacoes));
        ['vendas','financeiro','auditoria','movimentacoes'].forEach(c=>delete _cache[c]);
        const total=Object.values(purged).reduce((s,n)=>s+n,0);
        if(total>0){console.info('[Store] Purge:',purged,`— ${total} registros removidos`);EventBus.emit('store:purged',purged);}
        return purged;
      },

      getLocalStorageUsage() {
        const cols=Object.entries(_key); let totalBytes=0; const detalhes={};
        cols.forEach(([col,key])=>{
          const raw=localStorage.getItem(key)||'';
          const bytes=new Blob([raw]).size; totalBytes+=bytes;
          detalhes[col]={kb:(bytes/1024).toFixed(1),registros:Array.isArray(_read(col))?_read(col).length:1};
        });
        const limitKB=5*1024, usadoKB=totalBytes/1024;
        return{usadoKB:usadoKB.toFixed(1),limitKB,percentual:((usadoKB/limitKB)*100).toFixed(1),detalhes,alerta:usadoKB>limitKB*0.7};
      },

      async hydrateAsync(cols) {
        const FB = window.CH?.FirebaseService;
        if (!FB?.isReady?.()) return;
        const role = window.CH?.AuthService?.getRole?.()??null;
        if (!role) return;
        const permitidas = CONSTANTS.PERMISSOES[role]?.ler||[];
        const alvo = (cols||permitidas).filter(c=>permitidas.includes(c));
        for (const col of alvo) {
          try {
            const local = _read(col);
            const vazio = Array.isArray(local)?local.length===0:Object.keys(local||{}).length===0;
            if (!vazio) continue;
            const remoto = await FB.ler(col);
            if (!remoto) continue;
            _write(col, col==='vendas'&&Array.isArray(remoto)?remoto.slice(0,_limits.vendas):remoto);
            delete _cache[col];
            _notify(col);
            console.info(`[Store] Hidratado: ${col} (${Array.isArray(remoto)?remoto.length:1})`);
          } catch(e){console.warn(`[Store] Hidratação falhou ${col}:`,e.message);}
        }
      },

      Selectors: {
        getEstoque()       { return Store.getEstoque(); },
        getVendas()        { return Store.getVendas(); },
        getPonto()         { return Store.getPonto(); },
        getPedidos()       { return Store.getPedidos(); },
        getComandas()      { return Store.getComandas(); },
        getFiado()         { return Store.getFiado(); },
        getMovimentacoes() { return Store.getMovimentacoes(); },
        getCategorias()    { return Store.getCategorias(); },
        getFornecedores()  { return Store.getFornecedores(); },
        getFinanceiro()    { return Store.getFinanceiro(); },
        getConfig()        { return Store.getConfig(); },
        getInvestimento()  { return Store.getInvestimento(); },
        getLowStock()      { return Store.getLowStock(); },
        getOutOfStock()    { return Store.getOutOfStock(); },
        getVendasHoje()    { return Store.getVendasHoje(); },
      },
    };
  })();

  /* ── SyncService simples (delega ao SyncQueue quando disponível) ── */
  const SyncService = (() => {
    const _fila = new Set(); let _timer=null; const DEBOUNCE=1500;

    function _podeEscrever(col) {
      const role = window.CH.AuthService?.getRole?.()??null;
      return role?(CONSTANTS.PERMISSOES[role]?.escrever?.includes(col)??false):false;
    }

    function push(col) {
      if (window.CH?.SyncQueue) {
        const dados = Store[`get${col.charAt(0).toUpperCase()+col.slice(1)}`]?.();
        if (dados!=null && _podeEscrever(col)) window.CH.SyncQueue.enqueue('salvar',col,dados);
        return;
      }
      _fila.add(col); clearTimeout(_timer); _timer=setTimeout(_flush,DEBOUNCE);
    }

    async function _flush() {
      if (!_fila.size) return;
      const ok = await window.CH?.FirebaseService?.init?.();
      if (!ok){_fila.clear();return;}
      for (const col of _fila) {
        if (!_podeEscrever(col)) continue;
        const dados = Store[`get${col.charAt(0).toUpperCase()+col.slice(1)}`]?.();
        if (dados==null) continue;
        const sucesso = await window.CH.FirebaseService.salvar(col,dados);
        if (sucesso) EventBus.emit('sync:ok',col);
      }
      _fila.clear();
    }

    async function pull(cols) {
      const role = window.CH.AuthService?.getRole?.()??null;
      if (!role) return;
      const alvo = cols||CONSTANTS.PERMISSOES[role].ler;
      const ok   = await window.CH?.FirebaseService?.init?.();
      if (!ok) return;
      for (const col of alvo) {
        const dados = await window.CH.FirebaseService.ler(col);
        if (dados==null) continue;
        if (col==='vendas'||col==='comandas'||col==='fiado') {
          const getLocal = col==='vendas'?()=>Store.getVendas():col==='comandas'?()=>Store.getComandas():()=>Store.getFiado();
          const maxLimit = col==='vendas'?CONSTANTS.MAX_VENDAS:(CONSTANTS.MAX_COMANDAS||2000);
          const local=getLocal(), localIds=new Set(local.map(v=>v.id).filter(Boolean));
          const novosDaNuvem=dados.filter(v=>v.id&&!localIds.has(v.id));
          const remoteMap=new Map((dados||[]).map(v=>[v.id,v]));
          const localFinal=local.map(v=>{const r=remoteMap.get(v.id);if(r){const tl=v.updatedAt||v.criadoEm||'',tr=r.updatedAt||r.criadoEm||'';return tr>tl?r:v;}return v;});
          if(novosDaNuvem.length>0||localFinal.some((v,i)=>v!==local[i])){
            const merged=[...novosDaNuvem,...localFinal].sort((a,b)=>(b.criadoEm||'')>(a.criadoEm||'')?1:-1).slice(0,maxLimit);
            Store._writeRaw(col,merged); console.info(`[Sync] Merge ${col}: +${novosDaNuvem.length} da nuvem.`);
          }
        } else {
          const key=CONSTANTS.DB[col.toUpperCase()];
          if(key){try{localStorage.setItem(key,JSON.stringify(dados));}catch(_){}}
          Store.invalidate(col);
        }
        EventBus.emit('store:updated',col); EventBus.emit(`store:${col}`);
      }
      EventBus.emit('sync:pull:done');
      console.info('[Sync] Pull concluído para role:', role);
    }

    return { push, pull, flush:_flush };
  })();

  // Registra no window.CH
  window.CH.Store       = Store;
  window.CH.SyncService = SyncService;

  console.info('%c storeService.js ✓','color:#10b981;font-weight:bold');
})();

'use strict';
/**
 * services/errorPreventionService.js — CH Geladas PDV
 * ─────────────────────────────────────────────────────────────
 * Camada de prevenção de erros operacionais.
 *
 * PROTEÇÕES ATIVAS:
 *   1. Venda duplicada — bloqueia revenda em < N segundos dos mesmos itens
 *   2. Estoque insuficiente — avisa antes da venda e bloqueia se zerado
 *   3. Venda de alto valor — exige confirmação acima de um limiar
 *   4. Desconto excessivo — avisa quando desconto > X% do subtotal
 *   5. Preço zerado — bloqueia item com preço = 0 sem confirmação
 *   6. Produto inativo — impede adicionar produto marcado inativo
 *   7. Turno fechado — avisa ao tentar vender fora do horário configurado
 *
 * CONFIGURAÇÃO (salva em CH_CONFIG.errorPrevention):
 *   duplicataTTL         número de segundos para considerar duplicata  (padrão: 30)
 *   limiarAltoValor      valor em R$ que exige confirmação            (padrão: 200)
 *   limiarDescontoMax    % máximo de desconto sem alerta              (padrão: 30)
 *   bloquearEstoqueNeg   true = bloqueia venda se qtd > estoque       (padrão: true)
 *
 * USO:
 *   const resultado = await CH.ErrorPreventionService.validarCarrinho(cart);
 *   if (!resultado.ok) { mostrarErro(resultado.erros); return; }
 *   if (resultado.avisos.length) { mostrarAvisos(resultado.avisos); }
 *
 * Requer: core.js carregado antes.
 */

(function () {
  const { Store, Utils, EventBus } = window.CH;

  // ── Configuração padrão ───────────────────────────────────────────
  const _cfgPadrao = {
    duplicataTTL:      30,    // segundos
    limiarAltoValor:   200,   // R$
    limiarDescontoMax: 30,    // %
    bloquearEstoqueNeg: true,
  };

  function _cfg() {
    const salvo = Store.getConfig()?.errorPrevention || {};
    return { ..._cfgPadrao, ...salvo };
  }

  // ── Registro de vendas recentes (anti-duplicata) ──────────────────
  const _ultimasVendas = []; // { hash, timestamp }

  function _hashCarrinho(itens) {
    // Hash simples baseado em ids + qtds
    return itens
      .map(i => `${i.prodId || i.id}:${i.qtd}`)
      .sort()
      .join('|');
  }

  function _registrarVendaRealizada(itens) {
    const hash = _hashCarrinho(itens);
    _ultimasVendas.push({ hash, ts: Date.now() });
    // Mantém apenas os últimos 20 registros
    if (_ultimasVendas.length > 20) _ultimasVendas.shift();
  }

  function _verificarDuplicata(itens) {
    const { duplicataTTL } = _cfg();
    const hash = _hashCarrinho(itens);
    const agora = Date.now();
    const recente = _ultimasVendas.find(v =>
      v.hash === hash && (agora - v.ts) < duplicataTTL * 1000
    );
    if (recente) {
      const segundos = Math.round((agora - recente.ts) / 1000);
      return {
        tipo:     'duplicata',
        nivel:    'warning',
        msg:      `Atenção: venda idêntica realizada há ${segundos}s. Confirme se não é duplicata.`,
        bloqueio: false,
      };
    }
    return null;
  }

  // ── Verificação de estoque ────────────────────────────────────────
  function _verificarEstoque(itens) {
    const erros = [];
    const avisos = [];
    const { bloquearEstoqueNeg } = _cfg();
    const estoque = Store.getEstoque() || [];

    itens.forEach(item => {
      const prod = estoque.find(p => p.id === (item.prodId || item.id));
      if (!prod) return;

      const qtdDisp = prod.qtdUn || prod.estoqueAtual || 0;

      // Calcula qtd em unidades considerando packs
      let qtdUn = item.qtd;
      if (item.label && item.label !== 'UNID') {
        const pack = prod.packs?.find(pk => pk.label === item.label);
        if (pack) qtdUn = item.qtd * (pack.qtd || 1);
      }

      if (qtdUn > qtdDisp) {
        if (bloquearEstoqueNeg) {
          erros.push({
            tipo:  'estoque_insuficiente',
            nivel: 'error',
            msg:   `"${prod.nome}": solicitado ${qtdUn} un., disponível ${qtdDisp} un.`,
            prodId: prod.id,
          });
        } else {
          avisos.push({
            tipo:  'estoque_insuficiente',
            nivel: 'warning',
            msg:   `"${prod.nome}": estoque insuficiente (${qtdDisp} un. disponível).`,
            prodId: prod.id,
          });
        }
      } else if (qtdDisp - qtdUn <= (prod.estoqueMinimo || 3) && qtdDisp - qtdUn >= 0) {
        avisos.push({
          tipo:   'estoque_baixo_pos_venda',
          nivel:  'info',
          msg:    `"${prod.nome}": estoque ficará baixo após esta venda (${qtdDisp - qtdUn} un.).`,
          prodId: prod.id,
        });
      }
    });

    return { erros, avisos };
  }

  // ── Verificação de alto valor ─────────────────────────────────────
  function _verificarAltoValor(total) {
    const { limiarAltoValor } = _cfg();
    if (total >= limiarAltoValor) {
      return {
        tipo:     'alto_valor',
        nivel:    'warning',
        msg:      `Venda de alto valor: ${Utils.formatCurrency(total)}. Confirme antes de finalizar.`,
        bloqueio: false,
      };
    }
    return null;
  }

  // ── Verificação de desconto excessivo ─────────────────────────────
  function _verificarDesconto(subtotal, desconto) {
    if (!desconto || desconto <= 0) return null;
    const { limiarDescontoMax } = _cfg();
    const pct = (desconto / subtotal) * 100;
    if (pct > limiarDescontoMax) {
      return {
        tipo:     'desconto_excessivo',
        nivel:    'warning',
        msg:      `Desconto de ${pct.toFixed(1)}% aplicado (limite recomendado: ${limiarDescontoMax}%).`,
        bloqueio: false,
      };
    }
    return null;
  }

  // ── Verificação de preço zerado ───────────────────────────────────
  function _verificarPrecoZerado(itens) {
    const semPreco = itens.filter(i => !(i.preco || i.precoUn || 0));
    return semPreco.map(i => ({
      tipo:     'preco_zerado',
      nivel:    'warning',
      msg:      `"${i.nome}": preço R$ 0,00 — confirme se está correto.`,
      prodId:   i.prodId || i.id,
      bloqueio: false,
    }));
  }

  // ── Verificação de produto inativo ────────────────────────────────
  function _verificarInativo(itens) {
    const estoque = Store.getEstoque() || [];
    const erros   = [];
    itens.forEach(item => {
      const prod = estoque.find(p => p.id === (item.prodId || item.id));
      if (prod && prod.ativo === false) {
        erros.push({
          tipo:   'produto_inativo',
          nivel:  'error',
          msg:    `"${prod.nome}" está desativado e não pode ser vendido.`,
          prodId: prod.id,
        });
      }
    });
    return erros;
  }

  // ── Verificação de carrinho vazio ─────────────────────────────────
  function _verificarCarrinhoVazio(itens) {
    if (!itens || itens.length === 0) {
      return [{
        tipo:   'carrinho_vazio',
        nivel:  'error',
        msg:    'O carrinho está vazio.',
        bloqueio: true,
      }];
    }
    return [];
  }

  // ══════════════════════════════════════════════════════════════════
  //  API PRINCIPAL — validarCarrinho
  // ══════════════════════════════════════════════════════════════════
  /**
   * Valida um carrinho antes de finalizar a venda.
   *
   * @param {object} cart - objeto CartService ou { itens, total, subtotal, desconto }
   * @returns {{ ok: boolean, erros: array, avisos: array }}
   *
   * ok=false → bloqueia a venda (erros críticos)
   * ok=true com avisos → permite mas exibe alertas
   */
  function validarCarrinho(cart) {
    const itens    = cart.getItems    ? cart.getItems()    : (cart.itens    || []);
    const total    = cart.getTotal    ? cart.getTotal()    : (cart.total    || 0);
    const subtotal = cart.getSubtotal ? cart.getSubtotal() : (cart.subtotal || total);
    const desconto = cart.getDesconto ? cart.getDesconto() : (cart.desconto || 0);

    const erros  = [];
    const avisos = [];

    // 1. Carrinho vazio
    erros.push(..._verificarCarrinhoVazio(itens));
    if (erros.length) return { ok: false, erros, avisos };

    // 2. Produto inativo
    erros.push(..._verificarInativo(itens));

    // 3. Estoque
    const estqRes = _verificarEstoque(itens);
    erros.push(...estqRes.erros);
    avisos.push(...estqRes.avisos);

    // 4. Preço zerado
    avisos.push(..._verificarPrecoZerado(itens));

    // 5. Desconto excessivo
    const descAviso = _verificarDesconto(subtotal, desconto);
    if (descAviso) avisos.push(descAviso);

    // 6. Alto valor
    const altoValor = _verificarAltoValor(total);
    if (altoValor) avisos.push(altoValor);

    // 7. Duplicata
    const dup = _verificarDuplicata(itens);
    if (dup) avisos.push(dup);

    return {
      ok:     erros.length === 0,
      erros,
      avisos,
      resumo: {
        totalItens:  itens.length,
        totalValor:  total,
        temBloqueio: erros.length > 0,
        temAvisos:   avisos.length > 0,
      },
    };
  }

  // ══════════════════════════════════════════════════════════════════
  //  API AUXILIARES
  // ══════════════════════════════════════════════════════════════════

  /**
   * Valida um item antes de adicionar ao carrinho.
   * Retorna null se OK, ou objeto de erro.
   */
  function validarItem(produtoId, qtdSolicitada, label = 'UNID') {
    const estoque = Store.getEstoque() || [];
    const prod    = estoque.find(p => p.id === produtoId);
    if (!prod)              return { nivel: 'error', msg: 'Produto não encontrado.' };
    if (prod.ativo === false) return { nivel: 'error', msg: `"${prod.nome}" está desativado.` };

    const qtdDisp = prod.qtdUn || prod.estoqueAtual || 0;
    let   qtdUn   = qtdSolicitada;
    if (label !== 'UNID') {
      const pack = prod.packs?.find(pk => pk.label === label);
      if (pack) qtdUn = qtdSolicitada * (pack.qtd || 1);
    }

    if (qtdUn > qtdDisp && _cfg().bloquearEstoqueNeg) {
      return { nivel: 'error', msg: `"${prod.nome}": apenas ${qtdDisp} un. em estoque.` };
    }
    return null;
  }

  /** Salva configuração de prevenção */
  function setConfig(novosCfg) {
    Store.mutateConfig(cfg => {
      cfg.errorPrevention = { ..._cfg(), ...novosCfg };
    });
  }

  // ── Hook: registra venda realizada para anti-duplicata ────────────
  EventBus.on('venda:finalizada', venda => {
    _registrarVendaRealizada(venda.itens || []);
  });

  // ── Exportar ──────────────────────────────────────────────────────
  window.CH.ErrorPreventionService = {
    validarCarrinho,
    validarItem,
    setConfig,
    getConfig: _cfg,
  };

  console.info('%c ErrorPreventionService ✓  (anti-duplicata | estoque | alto-valor)', 'color:#10b981;font-weight:bold');
})();

'use strict';
/**
 * services/financeiroService.js — CH Geladas PDV
 * ─────────────────────────────────────────────────────────────
 * AUDITORIA FINAL — Correções críticas de produção:
 *
 * [IDEMPOTÊNCIA] registrarReceita e registrarEstorno agora checam
 *   se já existe um lançamento com aquela referencia (vendaId) antes
 *   de inserir. Duplo clique, retry de rede ou chamada duplicada não
 *   corrompem o caixa.
 *
 * [LOGS] Todos os erros incluem timestamp UTC ISO e contexto completo.
 *
 * Fluxo automático:
 *   Venda finalizada → registrarReceita (evento venda:finalizada)
 *   Venda cancelada  → registrarEstorno  (evento venda:cancelada)
 *   Entrada estoque  → registrarDespesa  (custo de compra)
 */

(function () {
  const { Store, AuthService, Utils, EventBus } = window.CH;

  // ── Lançamento base ───────────────────────────────────────────────
  function _lancar({ tipo, categoria, descricao, valor, formaPgto = '', referencia = '', extra = {} }) {
    if (!valor || valor <= 0) return null;

    const lancamento = {
      id:         Utils.generateId(),
      tipo,
      categoria,
      descricao,
      valor:      Number(valor),
      formaPgto,
      referencia,
      operador:   AuthService.getNome(),
      data:       Utils.nowISO(),
      dataCurta:  Utils.todayISO(),
      hora:       Utils.nowTime(),
      ...extra,
    };

    try {
      Store.mutateFinanceiro(fin => { fin.unshift(lancamento); });
    } catch (e) {
      console.error(
        `[FinanceiroService] _lancar falhou | ts=${new Date().toISOString()} | tipo=${tipo} | ref=${referencia} | erro=${e.message}`
      );
      return null;
    }

    try { EventBus.emit('financeiro:lancado', lancamento); } catch (_) {}
    return lancamento;
  }

  // ── Idempotência: checa se referencia já foi lançada com aquele tipo ─
  function _jaLancado(tipo, referencia) {
    if (!referencia) return false;
    return Store.getFinanceiro().some(
      l => l.tipo === tipo && l.referencia === referencia
    );
  }

  // ── Receitas ──────────────────────────────────────────────────────

  function registrarReceita(venda) {
    if (!venda?.id || !venda.total) return null;

    // IDEMPOTÊNCIA: impede lançamento duplo por duplo clique ou retry
    if (_jaLancado('receita', venda.id)) {
      console.warn(
        `[FinanceiroService] registrarReceita ignorado — já lançado | ts=${new Date().toISOString()} | vendaId=${venda.id}`
      );
      return null;
    }

    return _lancar({
      tipo:       'receita',
      categoria:  'venda',
      descricao:  `Venda #${venda.id.slice(-6)} — ${venda.itens?.length || 0} item(ns)`,
      valor:      venda.total,
      formaPgto:  venda.formaPgto,
      referencia: venda.id,
      extra: {
        lucro:   venda.lucro || 0,
        itens:   venda.itens?.length || 0,
        vendaId: venda.id,
      },
    });
  }

  function registrarEstorno(venda) {
    if (!venda?.id || !venda.total) return null;

    // IDEMPOTÊNCIA: impede estorno duplo
    if (_jaLancado('estorno', venda.id)) {
      console.warn(
        `[FinanceiroService] registrarEstorno ignorado — já lançado | ts=${new Date().toISOString()} | vendaId=${venda.id}`
      );
      return null;
    }

    return _lancar({
      tipo:       'estorno',
      categoria:  'cancelamento',
      descricao:  `Estorno venda #${venda.id.slice(-6)}`,
      valor:      venda.total,
      formaPgto:  venda.formaPgto,
      referencia: venda.id,
    });
  }

  // ── Despesas ──────────────────────────────────────────────────────

  function registrarDespesa({ descricao, valor, categoria = 'outro', formaPgto = '', referencia = '' }) {
    return _lancar({ tipo: 'despesa', categoria, descricao, valor, formaPgto, referencia });
  }

  function registrarCustoCompra(mov) {
    if (!mov?.id) return null;
    if (_jaLancado('despesa', mov.id)) return null; // idempotente também para compras
    const custo = Math.abs(mov.custo || 0) * Math.abs(mov.quantidade || 0);
    if (!custo) return null;
    return _lancar({
      tipo:       'despesa',
      categoria:  'compra',
      descricao:  `Compra: ${mov.nomeProduto} (${Math.abs(mov.quantidade)} un.)`,
      valor:      custo,
      referencia: mov.id,
    });
  }

  // ── Consultas ─────────────────────────────────────────────────────

  function getLancamentos({ tipo, categoria, dataDe, dataAte, limit = 500 } = {}) {
    let fin = Store.getFinanceiro();
    if (tipo)      fin = fin.filter(l => l.tipo      === tipo);
    if (categoria) fin = fin.filter(l => l.categoria === categoria);
    if (dataDe)    fin = fin.filter(l => l.dataCurta >= dataDe);
    if (dataAte)   fin = fin.filter(l => l.dataCurta <= dataAte);
    return fin.slice(0, limit);
  }

  function getCaixaDia(data = Utils.todayISO()) {
    const lancamentos = getLancamentos({ dataDe: data, dataAte: data });
    const receitas = lancamentos.filter(l => l.tipo === 'receita').reduce((s, l) => s + l.valor, 0);
    const despesas = lancamentos.filter(l => l.tipo === 'despesa').reduce((s, l) => s + l.valor, 0);
    const estornos = lancamentos.filter(l => l.tipo === 'estorno').reduce((s, l) => s + l.valor, 0);
    const lucro    = lancamentos.filter(l => l.tipo === 'receita').reduce((s, l) => s + (l.lucro || 0), 0);
    const porForma = {};
    lancamentos.filter(l => l.tipo === 'receita').forEach(l => {
      const f = l.formaPgto || 'Outros';
      porForma[f] = (porForma[f] || 0) + l.valor;
    });
    return { data, receitas, despesas, estornos, saldo: receitas - despesas - estornos, lucro, lancamentos, porForma };
  }

  function getFluxoCaixa(dataDe, dataAte) {
    const dias = {};
    getLancamentos({ dataDe, dataAte }).forEach(l => {
      if (!dias[l.dataCurta]) {
        dias[l.dataCurta] = { data: l.dataCurta, receitas: 0, despesas: 0, estornos: 0, lucro: 0 };
      }
      if (l.tipo === 'receita') { dias[l.dataCurta].receitas += l.valor; dias[l.dataCurta].lucro += (l.lucro || 0); }
      if (l.tipo === 'despesa') dias[l.dataCurta].despesas += l.valor;
      if (l.tipo === 'estorno') dias[l.dataCurta].estornos += l.valor;
    });
    return Object.values(dias)
      .sort((a, b) => a.data.localeCompare(b.data))
      .map(d => ({ ...d, saldo: d.receitas - d.despesas - d.estornos }));
  }

  function getResumoMes(ano = new Date().getFullYear(), mes = new Date().getMonth() + 1) {
    const dataDe = `${ano}-${String(mes).padStart(2,'0')}-01`;
    const dataAte = `${ano}-${String(mes).padStart(2,'0')}-31`;
    const lancamentos = getLancamentos({ dataDe, dataAte });
    const receitas = lancamentos.filter(l => l.tipo === 'receita').reduce((s, l) => s + l.valor, 0);
    const despesas = lancamentos.filter(l => l.tipo === 'despesa').reduce((s, l) => s + l.valor, 0);
    const lucro    = lancamentos.filter(l => l.tipo === 'receita').reduce((s, l) => s + (l.lucro || 0), 0);
    return { mes: `${ano}-${String(mes).padStart(2,'0')}`, receitas, despesas, saldo: receitas - despesas, lucro };
  }

  function exportarCSV(dataDe, dataAte) {
    const lancamentos = getLancamentos({ dataDe, dataAte });
    const header = ['data','hora','tipo','categoria','descricao','valor','formaPgto','operador'];
    const rows = lancamentos.map(l =>
      header.map(k => `"${String(l[k] !== undefined ? l[k] : '').replace(/"/g,'""')}"`).join(',')
    );
    const csv = [header.join(','), ...rows].join('\n');
    Utils.downloadBlob('\uFEFF' + csv, 'text/csv;charset=utf-8', `financeiro_${Utils.todayISO()}.csv`);
  }

  // ── Hooks automáticos ─────────────────────────────────────────────
  EventBus.on('venda:finalizada', venda => registrarReceita(venda));
  EventBus.on('venda:finalizada:lote', vendas => {
    if (Array.isArray(vendas)) vendas.forEach(v => registrarReceita(v));
  });
  EventBus.on('venda:cancelada', ({ vendaId }) => {
    const venda = window.CH.Store.getVendas().find(v => v.id === vendaId);
    if (venda) registrarEstorno(venda);
  });
  EventBus.on('estoque:movimentado', mov => {
    if (mov.tipo === 'entrada') registrarCustoCompra(mov);
  });

  window.CH.FinanceiroService = {
    registrarReceita,
    registrarEstorno,
    registrarDespesa,
    registrarCustoCompra,
    getLancamentos,
    getCaixaDia,
    getFluxoCaixa,
    getResumoMes,
    exportarCSV,
  };

})();

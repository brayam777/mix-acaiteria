import { supabase } from './supabase-config.js';
import { getStoreId } from './store.js';
import { currency } from './pricing.js';
import { esc } from './escape.js';

// Caixa: as vendas do cardápio entram sozinhas (get_acai_cash_summary soma os
// pedidos não cancelados); aqui o lojista só lança despesas e entradas avulsas
// (venda no balcão etc.) e vê quanto sobrou.

const TZ = 'America/Sao_Paulo';
const COLOR_SALES = '#6d3fa0';
const COLOR_EXPENSE = '#c8601f';

const PAYMENT_ROWS = [
  { order: 'pix_maquininha', entry: 'pix', label: '📱 Pix' },
  { order: 'cartao_maquininha', entry: 'cartao', label: '💳 Cartão' },
  { order: 'dinheiro', entry: 'dinheiro', label: '💵 Dinheiro' },
  { order: null, entry: 'outro', label: 'Outro' },
];
const ENTRY_PAYMENT_LABEL = { dinheiro: 'Dinheiro', pix: 'Pix', cartao: 'Cartão', outro: 'Outro' };

const el = (id) => document.getElementById(id);
const cashMessage = el('cashMessage');

let storeId = null;
let period = { key: 'today', from: null, to: null };
let summary = null;
let entries = [];
let categories = [];
let loaded = false;

function showMessage(text, isError = false) {
  cashMessage.textContent = text;
  cashMessage.classList.toggle('error', isError);
}

// ---------------- Datas (sempre no fuso da loja) ----------------
function todayStr() {
  return new Intl.DateTimeFormat('en-CA', { timeZone: TZ }).format(new Date());
}

function addDays(dateStr, n) {
  const d = new Date(`${dateStr}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

function fmtDate(dateStr, opts = { day: '2-digit', month: '2-digit' }) {
  return new Date(`${dateStr}T12:00:00Z`).toLocaleDateString('pt-BR', { timeZone: 'UTC', ...opts });
}

function rangeFor(key) {
  const today = todayStr();
  const [y, m] = today.split('-').map(Number);
  if (key === 'today') return { from: today, to: today };
  if (key === '7d') return { from: addDays(today, -6), to: today };
  if (key === 'month') return { from: `${today.slice(0, 7)}-01`, to: today };
  if (key === 'lastmonth') {
    const first = new Date(Date.UTC(m === 1 ? y - 1 : y, m === 1 ? 11 : m - 2, 1));
    const last = new Date(Date.UTC(y, m - 1, 0));
    return { from: first.toISOString().slice(0, 10), to: last.toISOString().slice(0, 10) };
  }
  return { from: period.from || today, to: period.to || today };
}

function periodLabel() {
  if (period.from === period.to) return fmtDate(period.from, { weekday: 'long', day: '2-digit', month: 'long' });
  return `${fmtDate(period.from)} a ${fmtDate(period.to)}`;
}

// ---------------- Carga ----------------
async function loadCategories() {
  const { data, error } = await supabase.from('acai_cash_categories').select('*').eq('store_id', storeId).order('kind').order('sort_order');
  if (error) return showMessage('Não foi possível carregar as categorias do caixa.', true);
  categories = data || [];
  renderCategoryList();
}

async function loadPeriod() {
  showMessage('Carregando...');
  const [{ data: sum, error: sumError }, { data: ents, error: entError }] = await Promise.all([
    supabase.rpc('get_acai_cash_summary', { p_store_id: storeId, p_from: period.from, p_to: period.to }),
    supabase
      .from('acai_cash_entries')
      .select('*')
      .eq('store_id', storeId)
      .gte('entry_date', period.from)
      .lte('entry_date', period.to)
      .order('entry_date', { ascending: false })
      .order('created_at', { ascending: false }),
  ]);
  if (sumError || entError) {
    console.error(sumError || entError);
    showMessage('Não foi possível carregar o caixa. Tente de novo.', true);
    return;
  }
  summary = sum;
  entries = ents || [];
  showMessage('');
  el('cashPeriodLabel').textContent = `Período: ${periodLabel()}`;
  renderAll();
}

function renderAll() {
  renderKpis();
  renderByPayment();
  renderByCategory();
  renderChart();
  renderEntries();
  renderTopProducts();
}

// ---------------- KPIs ----------------
function renderKpis() {
  const s = summary;
  const revenue = Number(s.sales_total) + Number(s.income_total);
  const expenses = Number(s.expense_total);
  const profit = revenue - expenses;
  const ticket = s.sales_count ? Number(s.sales_total) / s.sales_count : 0;

  el('cashKpis').innerHTML = `
    <div class="kpi">
      <div class="kpi-label">Faturamento</div>
      <div class="kpi-value">${currency(revenue)}</div>
      <div class="kpi-sub">Cardápio ${currency(s.sales_total)} · Avulsas ${currency(s.income_total)}</div>
    </div>
    <div class="kpi">
      <div class="kpi-label">Despesas</div>
      <div class="kpi-value">${currency(expenses)}</div>
      <div class="kpi-sub">${entries.filter((e) => e.kind === 'expense').length} lançamento(s)</div>
    </div>
    <div class="kpi ${profit >= 0 ? 'profit-positive' : 'profit-negative'}">
      <div class="kpi-label">${profit >= 0 ? 'Lucro' : 'Prejuízo'}</div>
      <div class="kpi-value">${currency(profit)}</div>
      <div class="kpi-sub">${revenue > 0 ? `${Math.round((profit / revenue) * 100)}% do faturamento` : 'sem vendas no período'}</div>
    </div>
    <div class="kpi">
      <div class="kpi-label">Pedidos</div>
      <div class="kpi-value">${s.sales_count}</div>
      <div class="kpi-sub">Ticket médio ${currency(ticket)}${s.awaiting_count ? ` · ${s.awaiting_count} aguardando aceite (fora da conta)` : ''}${s.pending_count ? ` · ${s.pending_count} em andamento` : ''}${s.cancelled_count ? ` · ${s.cancelled_count} cancelado(s)` : ''}</div>
    </div>`;
}

// ---------------- Fechamento por forma de pagamento ----------------
function renderByPayment() {
  const s = summary;
  let totIn = 0;
  let totOut = 0;
  const rows = PAYMENT_ROWS.map((r) => {
    const inOrders = r.order ? Number(s.sales_by_payment[r.order] || 0) : 0;
    const inEntries = Number(s.income_by_payment[r.entry] || 0);
    const out = Number(s.expense_by_payment[r.entry] || 0);
    totIn += inOrders + inEntries;
    totOut += out;
    return { label: r.label, inValue: inOrders + inEntries, out };
  }).filter((r) => r.inValue || r.out || r.label !== 'Outro');

  el('cashByPayment').innerHTML = `
    <table class="pay-table">
      <thead><tr><th>Forma</th><th>Entrou</th><th>Saiu</th><th>Saldo</th></tr></thead>
      <tbody>
        ${rows
          .map((r) => `<tr><td>${r.label}</td><td>${currency(r.inValue)}</td><td>${currency(r.out)}</td><td>${currency(r.inValue - r.out)}</td></tr>`)
          .join('')}
      </tbody>
      <tfoot><tr><td>Total</td><td>${currency(totIn)}</td><td>${currency(totOut)}</td><td>${currency(totIn - totOut)}</td></tr></tfoot>
    </table>
    ${Number(s.delivery_fees) > 0 ? `<p class="admin-sub" style="margin-top:8px">Inclui ${currency(s.delivery_fees)} de taxas de entrega.</p>` : ''}`;
}

// ---------------- Despesas por categoria ----------------
function renderByCategory() {
  const list = summary.expenses_by_category || [];
  if (!list.length) {
    el('cashByCategory').innerHTML = '<p class="admin-list-empty">Nenhuma despesa lançada no período.</p>';
    return;
  }
  const max = Math.max(...list.map((c) => Number(c.total)));
  const total = list.reduce((s, c) => s + Number(c.total), 0);
  el('cashByCategory').innerHTML = `<div class="bar-list">${list
    .map(
      (c) => `
      <div>
        <div class="bar-item-head"><span>${esc(c.name)}</span><span>${currency(c.total)} · ${Math.round((Number(c.total) / total) * 100)}%</span></div>
        <div class="bar-track"><div class="bar-fill" style="width:${Math.max((Number(c.total) / max) * 100, 2)}%"></div></div>
      </div>`
    )
    .join('')}</div>`;
}

// ---------------- Gráfico diário (SVG) ----------------
function niceMax(v) {
  if (v <= 0) return 100;
  const p = Math.pow(10, Math.floor(Math.log10(v)));
  const n = v / p;
  return (n <= 1 ? 1 : n <= 2 ? 2 : n <= 5 ? 5 : 10) * p;
}

function renderChart() {
  const chart = el('cashChart');
  const days = summary.daily || [];
  if (days.length < 2) {
    chart.innerHTML = '<p class="admin-list-empty">Escolha um período de mais de um dia pra ver o gráfico.</p>';
    return;
  }

  const data = days.map((d) => ({ day: d.day, sales: Number(d.sales) + Number(d.income), expense: Number(d.expense) }));
  const W = 720;
  const H = 240;
  const pad = { l: 56, r: 8, t: 10, b: 28 };
  const plotW = W - pad.l - pad.r;
  const plotH = H - pad.t - pad.b;
  const max = niceMax(Math.max(...data.map((d) => Math.max(d.sales, d.expense))));
  const slot = plotW / data.length;
  const barW = Math.max(Math.min((slot - 6) / 2, 18), 2);
  const y = (v) => pad.t + plotH - (v / max) * plotH;
  const labelEvery = Math.ceil(data.length / 10);

  // Barra com topo arredondado (4px) e base reta no eixo.
  const bar = (x, v, color) => {
    if (v <= 0) return '';
    const top = y(v);
    const h = pad.t + plotH - top;
    const r = Math.min(4, barW / 2, h);
    return `<path d="M${x},${pad.t + plotH} V${top + r} Q${x},${top} ${x + r},${top} H${x + barW - r} Q${x + barW},${top} ${x + barW},${top + r} V${pad.t + plotH} Z" fill="${color}" />`;
  };

  const ticks = [0, 0.25, 0.5, 0.75, 1].map((f) => max * f);
  chart.innerHTML = `
    <div class="chart-legend">
      <span><i style="background:${COLOR_SALES}"></i>Vendas + entradas</span>
      <span><i style="background:${COLOR_EXPENSE}"></i>Despesas</span>
    </div>
    <svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Vendas e despesas por dia">
      ${ticks
        .map(
          (t) => `<line x1="${pad.l}" x2="${W - pad.r}" y1="${y(t)}" y2="${y(t)}" stroke="rgba(42,20,64,0.08)" />
          <text x="${pad.l - 6}" y="${y(t) + 4}" text-anchor="end" font-size="11" fill="#6d5c80">${t >= 1000 ? `${(t / 1000).toLocaleString('pt-BR')} mil` : Math.round(t)}</text>`
        )
        .join('')}
      ${data
        .map((d, i) => {
          const x0 = pad.l + i * slot + (slot - (barW * 2 + 2)) / 2;
          return `<g data-i="${i}">
            <rect x="${pad.l + i * slot}" y="${pad.t}" width="${slot}" height="${plotH}" fill="transparent" />
            ${bar(x0, d.sales, COLOR_SALES)}
            ${bar(x0 + barW + 2, d.expense, COLOR_EXPENSE)}
            ${i % labelEvery === 0 ? `<text x="${pad.l + i * slot + slot / 2}" y="${H - 8}" text-anchor="middle" font-size="11" fill="#6d5c80">${fmtDate(d.day)}</text>` : ''}
          </g>`;
        })
        .join('')}
    </svg>
    <div class="chart-tooltip" hidden></div>`;

  const svg = chart.querySelector('svg');
  const tip = chart.querySelector('.chart-tooltip');
  svg.addEventListener('mousemove', (e) => {
    const g = e.target.closest('[data-i]');
    if (!g) return (tip.hidden = true);
    const d = data[Number(g.dataset.i)];
    const rect = svg.getBoundingClientRect();
    const scale = rect.width / W;
    tip.innerHTML = `<strong>${fmtDate(d.day, { weekday: 'short', day: '2-digit', month: '2-digit' })}</strong><br>
      Vendas: ${currency(d.sales)}<br>Despesas: ${currency(d.expense)}<br>Saldo: ${currency(d.sales - d.expense)}`;
    tip.style.left = `${(pad.l + Number(g.dataset.i) * slot + slot / 2) * scale}px`;
    tip.style.top = `${y(Math.max(d.sales, d.expense)) * scale + 28}px`;
    tip.hidden = false;
  });
  svg.addEventListener('mouseleave', () => (tip.hidden = true));
}

// ---------------- Lançamentos ----------------
function renderEntries() {
  const catName = new Map(categories.map((c) => [c.id, c.name]));
  if (!entries.length) {
    el('cashEntries').innerHTML = '<p class="admin-list-empty">Nenhum lançamento no período. As vendas do cardápio já entram sozinhas.</p>';
    return;
  }
  el('cashEntries').innerHTML = entries
    .map(
      (e) => `
      <div class="entry-row">
        <div class="entry-info">
          <div>${esc(catName.get(e.category_id) || 'Sem categoria')}${e.description ? ` — ${esc(e.description)}` : ''}</div>
          <div class="entry-meta">${fmtDate(e.entry_date)} · ${esc(ENTRY_PAYMENT_LABEL[e.payment_method] || e.payment_method)}</div>
        </div>
        <span class="entry-amount ${e.kind}">${e.kind === 'expense' ? '−' : '+'} ${currency(e.amount)}</span>
        <button type="button" class="link-btn" data-edit-entry="${esc(e.id)}">Editar</button>
        <button type="button" class="link-btn danger" data-delete-entry="${esc(e.id)}">Excluir</button>
      </div>`
    )
    .join('');
}

el('cashEntries').addEventListener('click', async (e) => {
  const editBtn = e.target.closest('[data-edit-entry]');
  const delBtn = e.target.closest('[data-delete-entry]');
  if (editBtn) {
    openEntryModal(entries.find((x) => x.id === editBtn.dataset.editEntry));
  } else if (delBtn) {
    if (!confirm('Excluir este lançamento?')) return;
    const { error } = await supabase.from('acai_cash_entries').delete().eq('id', delBtn.dataset.deleteEntry);
    if (error) return showMessage('Não foi possível excluir.', true);
    loadPeriod();
  }
});

function renderTopProducts() {
  const list = summary.top_products || [];
  el('cashTopProducts').innerHTML = list.length
    ? `<ul class="top-list">${list
        .map((p) => `<li><span>${esc(p.quantity)}x ${esc(p.name)}</span><span>${currency(p.total)}</span></li>`)
        .join('')}</ul>`
    : '<p class="admin-list-empty">Sem vendas no período.</p>';
}

// ---------------- Modal de lançamento ----------------
const modal = el('cashEntryModal');
const entryForm = el('cashEntryForm');

function openEntryModal(entry, kind = entry?.kind || 'expense') {
  entryForm.reset();
  el('cashEntryId').value = entry?.id || '';
  el('cashEntryKind').value = kind;
  el('cashEntryTitle').textContent = `${entry ? 'Editar' : 'Lançar'} ${kind === 'expense' ? 'despesa' : 'entrada'}`;
  el('cashEntryCategory').innerHTML = categories
    .filter((c) => c.kind === kind)
    .map((c) => `<option value="${esc(c.id)}">${esc(c.name)}</option>`)
    .join('');
  el('cashEntryAmount').value = entry?.amount ?? '';
  if (entry?.category_id) el('cashEntryCategory').value = entry.category_id;
  el('cashEntryDescription').value = entry?.description || '';
  el('cashEntryDate').value = entry?.entry_date || (period.to < todayStr() ? period.to : todayStr());
  el('cashEntryPayment').value = entry?.payment_method || 'dinheiro';
  el('cashEntryMessage').textContent = '';
  modal.hidden = false;
  el('cashEntryAmount').focus();
}

function closeEntryModal() {
  modal.hidden = true;
}

modal.addEventListener('click', (e) => {
  if (e.target.closest('[data-close-cash-modal]')) closeEntryModal();
});

entryForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  const id = el('cashEntryId').value;
  const amount = parseFloat(el('cashEntryAmount').value);
  if (!(amount > 0)) {
    el('cashEntryMessage').textContent = 'Informe um valor maior que zero.';
    return;
  }
  const payload = {
    kind: el('cashEntryKind').value,
    amount,
    category_id: el('cashEntryCategory').value || null,
    description: el('cashEntryDescription').value.trim() || null,
    entry_date: el('cashEntryDate').value,
    payment_method: el('cashEntryPayment').value,
  };
  const { error } = id
    ? await supabase.from('acai_cash_entries').update(payload).eq('id', id)
    : await supabase.from('acai_cash_entries').insert({ ...payload, store_id: storeId });
  if (error) {
    el('cashEntryMessage').textContent = `Não foi possível salvar: ${error.message}`;
    return;
  }
  closeEntryModal();
  loadPeriod();
});

el('addExpenseBtn').addEventListener('click', () => openEntryModal(null, 'expense'));
el('addIncomeBtn').addEventListener('click', () => openEntryModal(null, 'income'));

// ---------------- Categorias ----------------
function renderCategoryList() {
  el('cashCategoryList').innerHTML = categories
    .map(
      (c) => `
      <div class="admin-list-item admin-list-item-compact">
        <span class="admin-list-name" style="flex:1">${esc(c.name)} <small class="admin-list-meta">· ${c.kind === 'expense' ? 'despesa' : 'entrada'}</small></span>
        <div class="admin-list-item-actions">
          <button class="admin-list-edit" data-rename-cash-cat="${esc(c.id)}">Renomear</button>
          <button class="admin-list-delete" data-delete-cash-cat="${esc(c.id)}">Remover</button>
        </div>
      </div>`
    )
    .join('');
}

el('cashCategoryForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const name = el('cashCategoryName').value.trim();
  const kind = el('cashCategoryKind').value;
  if (!name) return;
  const { error } = await supabase
    .from('acai_cash_categories')
    .insert({ store_id: storeId, name, kind, sort_order: categories.filter((c) => c.kind === kind).length });
  if (error) return showMessage('Não foi possível criar a categoria.', true);
  el('cashCategoryForm').reset();
  loadCategories();
});

el('cashCategoryList').addEventListener('click', async (e) => {
  const renameBtn = e.target.closest('[data-rename-cash-cat]');
  const delBtn = e.target.closest('[data-delete-cash-cat]');
  if (renameBtn) {
    const c = categories.find((x) => x.id === renameBtn.dataset.renameCashCat);
    const name = prompt('Novo nome:', c.name);
    if (!name || !name.trim()) return;
    const { error } = await supabase.from('acai_cash_categories').update({ name: name.trim() }).eq('id', c.id);
    if (error) return showMessage('Não foi possível renomear.', true);
    await loadCategories();
    renderEntries();
  } else if (delBtn) {
    if (!confirm('Remover esta categoria? Os lançamentos dela ficam "Sem categoria".')) return;
    const { error } = await supabase.from('acai_cash_categories').delete().eq('id', delBtn.dataset.deleteCashCat);
    if (error) return showMessage('Não foi possível remover.', true);
    await loadCategories();
    loadPeriod();
  }
});

// ---------------- Período ----------------
el('cashPeriods').addEventListener('click', (e) => {
  const btn = e.target.closest('[data-period]');
  if (!btn) return;
  el('cashPeriods').querySelectorAll('.chip-btn').forEach((b) => b.classList.toggle('active', b === btn));
  const key = btn.dataset.period;
  el('cashCustom').hidden = key !== 'custom';
  if (key === 'custom') {
    el('cashFrom').value = period.from;
    el('cashTo').value = period.to;
    return;
  }
  period = { key, ...rangeFor(key) };
  loadPeriod();
});

el('cashApplyCustom').addEventListener('click', () => {
  const from = el('cashFrom').value;
  const to = el('cashTo').value;
  if (!from || !to || to < from) {
    showMessage('Escolha as duas datas (a final depois da inicial).', true);
    return;
  }
  period = { key: 'custom', from, to };
  loadPeriod();
});

// ---------------- CSV ----------------
function csvCell(v) {
  const s = String(v ?? '');
  return /[;"\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

const brNumber = (v) => Number(v).toFixed(2).replace('.', ',');

el('exportCsvBtn').addEventListener('click', () => {
  if (!summary) return;
  const catName = new Map(categories.map((c) => [c.id, c.name]));
  const lines = [['Dia', 'Vendas cardápio', 'Entradas avulsas', 'Despesas', 'Saldo']];
  for (const d of summary.daily) {
    lines.push([fmtDate(d.day, { day: '2-digit', month: '2-digit', year: 'numeric' }), brNumber(d.sales), brNumber(d.income), brNumber(d.expense), brNumber(Number(d.sales) + Number(d.income) - Number(d.expense))]);
  }
  lines.push([]);
  lines.push(['Lançamentos']);
  lines.push(['Data', 'Tipo', 'Categoria', 'Descrição', 'Forma', 'Valor']);
  for (const e of entries) {
    lines.push([
      fmtDate(e.entry_date, { day: '2-digit', month: '2-digit', year: 'numeric' }),
      e.kind === 'expense' ? 'Despesa' : 'Entrada',
      catName.get(e.category_id) || '',
      e.description || '',
      ENTRY_PAYMENT_LABEL[e.payment_method] || e.payment_method,
      brNumber(e.kind === 'expense' ? -e.amount : e.amount),
    ]);
  }
  const csv = '﻿' + lines.map((l) => l.map(csvCell).join(';')).join('\r\n');
  const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = `caixa_${period.from}_a_${period.to}.csv`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
});

// ---------------- Init (só quando a aba abre) ----------------
async function ensureLoaded() {
  if (loaded) return loadPeriod();
  loaded = true;
  storeId = await getStoreId();
  period = { key: 'today', ...rangeFor('today') };
  await loadCategories();
  await loadPeriod();
}

window.addEventListener('admin:tab', (e) => {
  if (e.detail === 'cash') ensureLoaded();
});

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && !modal.hidden) closeEntryModal();
});

'use strict';

// Lightweight vanilla PWA for the Profitable Solutions operating system. It
// talks to the same-origin JSON API. Money is handled in integer cents on the
// client for display only; the server recomputes every total authoritatively.

const $ = (id) => document.getElementById(id);
const money = (cents) => '$' + (cents / 100).toFixed(2);
const centsOf = (priceStr) => Math.round(parseFloat(priceStr) * 100);

async function api(path, opts) {
  const res = await fetch(path, {
    headers: { 'content-type': 'application/json' },
    ...opts,
  });
  const text = await res.text();
  const body = text ? JSON.parse(text) : null;
  if (!res.ok) throw new Error((body && body.error) || `HTTP ${res.status}`);
  return body;
}

function toast(msg) {
  const t = $('toast');
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toast._t);
  toast._t = setTimeout(() => (t.hidden = true), 2200);
}

// ---- tabs ----
document.querySelectorAll('.tab').forEach((tab) => {
  tab.addEventListener('click', () => {
    document.querySelectorAll('.tab').forEach((t) => t.classList.remove('is-active'));
    document.querySelectorAll('.view').forEach((v) => v.classList.remove('is-active'));
    tab.classList.add('is-active');
    $('view-' + tab.dataset.view).classList.add('is-active');
    if (tab.dataset.view === 'portal') loadOrgs();
  });
});

// ---- order entry ----
const state = { sale: null, skus: new Map(), lines: [] };

async function loadSales() {
  const sel = $('saleSelect');
  sel.innerHTML = '';
  const sales = await api('/sales?status=open');
  if (!sales.length) {
    const o = document.createElement('option');
    o.textContent = 'No open sales';
    o.value = '';
    sel.appendChild(o);
    state.sale = null;
    return;
  }
  for (const s of sales) {
    const o = document.createElement('option');
    o.value = s.id;
    o.textContent = `${s.organization_name} — ${s.name}`;
    sel.appendChild(o);
  }
  await selectSale(sel.value);
}

async function selectSale(saleId) {
  state.sale = saleId || null;
  state.skus = new Map();
  state.lines = [];
  renderLines();
  $('skuRef').innerHTML = '';
  if (!saleId) return;
  const skus = await api(`/sales/${saleId}/skus`);
  const ref = $('skuRef');
  for (const s of skus) {
    state.skus.set(s.sku_code.toUpperCase(), s);
    const div = document.createElement('div');
    div.className = 'ref-item';
    div.innerHTML = `<code>${s.sku_code}</code> ${s.product_name || ''}<br>${money(centsOf(s.price))}`;
    ref.appendChild(div);
  }
}

function renderLines() {
  const body = $('linesBody');
  body.innerHTML = '';
  let totalCents = 0;
  let items = 0;
  state.lines.forEach((l, i) => {
    const lineCents = centsOf(l.price) * l.quantity;
    totalCents += lineCents;
    items += l.quantity;
    const tr = document.createElement('tr');
    tr.innerHTML = `<td><code>${l.sku_code}</code></td><td>${l.product_name || ''}</td>` +
      `<td class="num">${l.quantity}</td><td class="num">${money(centsOf(l.price))}</td>` +
      `<td class="num">${money(lineCents)}</td>` +
      `<td><button class="del" data-i="${i}" aria-label="Remove">×</button></td>`;
    body.appendChild(tr);
  });
  $('linesTable').hidden = state.lines.length === 0;
  $('orderTotal').textContent = money(totalCents);
  $('itemCount').textContent = String(items);
  $('saveOrder').disabled = state.lines.length === 0;
}

function addLine() {
  const code = $('skuCode').value.trim().toUpperCase();
  const qty = parseInt($('qty').value, 10);
  const hint = $('skuHint');
  if (!code) return;
  const sku = state.skus.get(code);
  if (!sku) {
    hint.textContent = `Unknown code "${code}"`;
    hint.className = 'hint err';
    return;
  }
  if (!Number.isInteger(qty) || qty <= 0) {
    hint.textContent = 'Enter a quantity of 1 or more';
    hint.className = 'hint err';
    $('qty').focus();
    return;
  }
  const existing = state.lines.find((l) => l.sku_id === sku.sku_id);
  if (existing) existing.quantity += qty;
  else state.lines.push({ sku_id: sku.sku_id, sku_code: sku.sku_code, product_name: sku.product_name, price: sku.price, quantity: qty });
  hint.textContent = '';
  hint.className = 'hint';
  $('skuCode').value = '';
  $('qty').value = '1';
  $('skuCode').focus();
  renderLines();
}

async function saveOrder() {
  if (!state.sale || state.lines.length === 0) return;
  const buyerName = $('buyerName').value.trim();
  const sellerCode = $('sellerCode').value.trim();
  const payload = {
    campaignId: state.sale,
    buyer: buyerName ? { displayName: buyerName } : {},
    entryChannel: 'paper',
    lines: state.lines.map((l) => ({ skuId: l.sku_id, quantity: l.quantity })),
  };
  if (sellerCode) payload.sellerCode = sellerCode;
  try {
    const order = await api('/orders', { method: 'POST', body: JSON.stringify(payload) });
    toast(`Saved ${order.order_number} — ${money(centsOf(order.subtotal))}`);
    // Save and immediately start the next order.
    state.lines = [];
    $('buyerName').value = '';
    $('sellerCode').value = '';
    renderLines();
    $('buyerName').focus();
  } catch (e) {
    toast('Save failed: ' + e.message);
  }
}

// keyboard flow: buyer -> Enter -> sku; sku -> Enter -> qty; qty -> Enter -> add
$('buyerName').addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); $('skuCode').focus(); } });
$('skuCode').addEventListener('keydown', (e) => {
  if (e.key !== 'Enter') return;
  e.preventDefault();
  const code = $('skuCode').value.trim().toUpperCase();
  if (state.skus.has(code)) $('qty').focus();
  else addLine();
});
$('qty').addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); addLine(); } });
$('addLine').addEventListener('click', addLine);
$('saveOrder').addEventListener('click', saveOrder);
$('reloadSales').addEventListener('click', () => loadSales().catch((e) => toast(e.message)));
$('saleSelect').addEventListener('change', (e) => selectSale(e.target.value).catch((err) => toast(err.message)));
$('linesBody').addEventListener('click', (e) => {
  const i = e.target.getAttribute && e.target.getAttribute('data-i');
  if (i !== null && i !== undefined) { state.lines.splice(Number(i), 1); renderLines(); }
});
// Ctrl/Cmd+Enter saves from anywhere.
document.addEventListener('keydown', (e) => { if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') saveOrder(); });

// ---- team portal ----
async function loadOrgs() {
  const sel = $('orgSelect');
  if (sel.dataset.loaded) return;
  const orgs = await api('/organizations');
  sel.innerHTML = '';
  for (const o of orgs) {
    const opt = document.createElement('option');
    opt.value = o.id;
    opt.textContent = o.name;
    sel.appendChild(opt);
  }
  sel.dataset.loaded = '1';
  sel.addEventListener('change', () => refreshPortal(sel.value));
  if (sel.value) refreshPortal(sel.value);
}

async function refreshPortal(orgId) {
  if (!orgId) return;
  // Customer base
  try {
    const customers = await api(`/organizations/${orgId}/customers`);
    $('customerBase').innerHTML = customers.length
      ? tableHtml(['Customer', 'Last order'], customers.map((c) => [c.display_name || '(no name)', fmtDate(c.last_order_at)]))
      : 'No customers yet.';
  } catch (e) { $('customerBase').textContent = e.message; }
  // Leaderboard
  try {
    const rows = await api(`/reports/leaderboard?organizationId=${orgId}`);
    $('leaderboard').innerHTML = tableHtml(
      ['Seller', 'Units', 'Revenue'],
      rows.map((r) => [r.display_name || r.seller_code, r.units, money(centsOf(r.revenue))]),
    );
  } catch (e) { $('leaderboard').textContent = e.message; }
  // Order history + countdown for the org's most recent sale
  try {
    const sales = await api(`/sales?organizationId=${orgId}`);
    if (sales.length) {
      const sale = sales[0];
      const orders = await api(`/sales/${sale.id}/orders`);
      $('orderHistory').innerHTML = `<div style="margin-bottom:8px"><strong>${sale.name}</strong> (${sale.status})</div>` +
        (orders.length ? tableHtml(['Order', 'Total'], orders.map((o) => [o.order_number, money(centsOf(o.subtotal))])) : 'No orders.');
      renderCountdown(sale.next_sale_target);
    } else {
      $('orderHistory').textContent = 'No sales yet.';
      renderCountdown(null);
    }
  } catch (e) { $('orderHistory').textContent = e.message; }
}

function renderCountdown(target) {
  const el = $('countdown');
  if (!target) { el.hidden = true; return; }
  const days = Math.ceil((new Date(target).getTime() - Date.now()) / 86400000);
  el.hidden = false;
  el.textContent = days > 0
    ? `Next sale in ${days} day${days === 1 ? '' : 's'} — register now for your incentive.`
    : 'Your next sale window is open — register now for your incentive.';
}

function tableHtml(headers, rows) {
  const head = '<tr>' + headers.map((h, i) => `<th class="${i === 0 ? '' : 'num'}">${h}</th>`).join('') + '</tr>';
  const body = rows.map((r) => '<tr>' + r.map((c, i) => `<td class="${i === 0 ? '' : 'num'}">${c}</td>`).join('') + '</tr>').join('');
  return `<table>${head}${body}</table>`;
}
function fmtDate(d) { return d ? new Date(d).toLocaleDateString() : '—'; }

// ---- boot ----
loadSales().catch((e) => toast(e.message));
if ('serviceWorker' in navigator) navigator.serviceWorker.register('/app/sw.js').catch(() => {});

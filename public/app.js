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

// CSV export. This business lives in spreadsheets, so every list should be one
// click away from Excel. Fields are quoted when they contain a comma, quote, or
// newline, with internal quotes doubled -- the standard CSV escaping.
function toCsv(headers, rows) {
  const esc = (v) => {
    const s = v === null || v === undefined ? '' : String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return [headers.map(esc).join(','), ...rows.map((r) => r.map(esc).join(','))].join('\r\n');
}

function downloadCsv(filename, headers, rows) {
  const blob = new Blob([toCsv(headers, rows)], { type: 'text/csv' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

// ---- tabs ----
document.querySelectorAll('.tab').forEach((tab) => {
  tab.addEventListener('click', () => {
    document.querySelectorAll('.tab').forEach((t) => t.classList.remove('is-active'));
    document.querySelectorAll('.view').forEach((v) => v.classList.remove('is-active'));
    tab.classList.add('is-active');
    $('view-' + tab.dataset.view).classList.add('is-active');
    if (tab.dataset.view === 'portal') loadOrgs();
    if (tab.dataset.view === 'sales') loadSalesAdmin();
    if (tab.dataset.view === 'receive') initReceiving();
    if (tab.dataset.view === 'fulfill') loadFulfillSales();
    if (tab.dataset.view === 'dashboard') loadDashboard();
    if (tab.dataset.view === 'payouts') loadPayouts();
    if (tab.dataset.view === 'catalog') loadCatalog();
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

// ---- receiving ----
// Catalog is loaded once and matched client-side by SKU code, QR code, or
// barcode, so a scan or a typed code resolves with no round trip. Receiving
// must be faster than paper: scan, quantity, done.
const recv = { warehouses: [], byKey: new Map(), skus: [], loaded: false, scanner: null };

async function initReceiving() {
  if (recv.loaded) return;
  try {
    const [warehouses, skus] = await Promise.all([api('/warehouses'), api('/skus')]);
    recv.warehouses = warehouses;
    recv.skus = skus;
    const wh = $('whSelect');
    wh.innerHTML = '';
    if (!warehouses.length) {
      const o = document.createElement('option');
      o.value = ''; o.textContent = 'No warehouse set up';
      wh.appendChild(o);
    }
    for (const w of warehouses) {
      const o = document.createElement('option');
      o.value = w.id; o.textContent = w.name;
      wh.appendChild(o);
    }
    recv.byKey = new Map();
    const ref = $('recvRef');
    ref.innerHTML = '';
    for (const s of skus) {
      if (s.sku_code) recv.byKey.set(s.sku_code.toUpperCase(), s);
      if (s.qr_code) recv.byKey.set(s.qr_code.toUpperCase(), s);
      if (s.barcode) recv.byKey.set(s.barcode.toUpperCase(), s);
      const div = document.createElement('div');
      div.className = 'ref-item';
      div.innerHTML = `<code>${s.sku_code}</code> ${s.product_name || ''}`;
      ref.appendChild(div);
    }
    recv.loaded = true;
    $('recvCode').focus();
  } catch (e) {
    toast(e.message);
  }
}

function recvLookup(raw) {
  const key = (raw || '').trim().toUpperCase();
  if (!key) return null;
  return recv.byKey.get(key) || null;
}

function showResolved(sku) {
  const el = $('recvResolved');
  if (!sku) { el.hidden = true; return; }
  el.hidden = false;
  el.innerHTML = `<strong>${sku.sku_code}</strong> — ${sku.product_name || ''}` +
    `<div class="muted">${sku.description || sku.unit_config || ''}</div>`;
}

async function receiveOne() {
  const sku = recvLookup($('recvCode').value);
  const hint = $('recvHint');
  if (!sku) {
    hint.textContent = `Unknown code "${$('recvCode').value.trim()}"`;
    hint.className = 'hint err';
    showResolved(null);
    return;
  }
  const qty = parseInt($('recvQty').value, 10);
  if (!Number.isInteger(qty) || qty <= 0) {
    hint.textContent = 'Enter a quantity of 1 or more';
    hint.className = 'hint err';
    $('recvQty').focus();
    return;
  }
  const warehouseId = $('whSelect').value;
  if (!warehouseId) {
    hint.textContent = 'No warehouse selected';
    hint.className = 'hint err';
    return;
  }
  try {
    await api('/inventory/receive', {
      method: 'POST',
      body: JSON.stringify({ skuId: sku.sku_id ?? sku.id, warehouseId, quantity: qty }),
    });
    // Read back the new on-hand for this SKU at this warehouse.
    let onHand = '';
    try {
      const snaps = await api(`/inventory/on-hand/${sku.sku_id ?? sku.id}`);
      const s = snaps.find((x) => x.warehouse_id === warehouseId) || snaps[0];
      onHand = s ? s.quantity_on_hand : '';
    } catch { /* on-hand read is best effort */ }
    addRecvRow(sku, qty, onHand);
    toast(`Received ${qty} × ${sku.sku_code}`);
    hint.textContent = '';
    hint.className = 'hint';
    $('recvCode').value = '';
    $('recvQty').value = '1';
    showResolved(null);
    $('recvCode').focus();
  } catch (e) {
    toast('Receive failed: ' + e.message);
  }
}

function addRecvRow(sku, qty, onHand) {
  const body = $('recvBody');
  const tr = document.createElement('tr');
  const t = new Date().toLocaleTimeString();
  tr.innerHTML = `<td>${t}</td><td><code>${sku.sku_code}</code></td>` +
    `<td>${sku.product_name || ''}</td><td class="num">${qty}</td>` +
    `<td class="num">${onHand === '' ? '—' : onHand}</td>`;
  body.insertBefore(tr, body.firstChild);
  $('recvTable').hidden = false;
}

$('recvCode').addEventListener('keydown', (e) => {
  if (e.key !== 'Enter') return;
  e.preventDefault();
  const sku = recvLookup($('recvCode').value);
  showResolved(sku);
  if (sku) { $('recvHint').textContent = ''; $('recvHint').className = 'hint'; $('recvQty').focus(); }
  else receiveOne();
});
$('recvCode').addEventListener('input', () => showResolved(recvLookup($('recvCode').value)));
$('recvQty').addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); receiveOne(); } });
$('recvAdd').addEventListener('click', receiveOne);

// Camera scan via the native BarcodeDetector. Not every browser has it (iOS
// Safari does not), so this is progressive: the manual code field always works.
async function startScan() {
  const note = $('scanNote');
  if (!('BarcodeDetector' in window)) {
    $('scanBox').hidden = false;
    note.textContent = 'This browser has no built-in scanner. Type the code instead.';
    return;
  }
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' } });
    const video = $('scanVideo');
    video.srcObject = stream;
    await video.play();
    $('scanBox').hidden = false;
    note.textContent = 'Point the camera at a code.';
    const detector = new window.BarcodeDetector({ formats: ['qr_code', 'code_128', 'ean_13', 'upc_a', 'code_39'] });
    recv.scanner = { stream, running: true };
    const tick = async () => {
      if (!recv.scanner || !recv.scanner.running) return;
      try {
        const codes = await detector.detect(video);
        if (codes && codes.length) {
          const value = codes[0].rawValue;
          const sku = recvLookup(value);
          if (sku) {
            stopScan();
            $('recvCode').value = sku.sku_code;
            showResolved(sku);
            $('recvQty').focus();
            toast(`Scanned ${sku.sku_code}`);
            return;
          }
          note.textContent = `Scanned "${value}" — no matching SKU.`;
        }
      } catch { /* transient detect errors are ignored */ }
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  } catch (e) {
    $('scanBox').hidden = false;
    note.textContent = 'Camera not available: ' + e.message + '. Type the code instead.';
  }
}

function stopScan() {
  if (recv.scanner) {
    recv.scanner.running = false;
    for (const t of recv.scanner.stream.getTracks()) t.stop();
    recv.scanner = null;
  }
  const video = $('scanVideo');
  if (video) video.srcObject = null;
  $('scanBox').hidden = true;
}

$('scanBtn').addEventListener('click', startScan);
$('scanStop').addEventListener('click', stopScan);

// Stock correction: a signed adjustment with a required reason. It never edits
// history -- the server writes a new offsetting ledger row (rule 1).
async function adjustStockUi() {
  const hint = $('adjHint');
  const sku = recvLookup($('adjCode').value);
  if (!sku) {
    hint.textContent = `Unknown code "${$('adjCode').value.trim()}"`;
    hint.className = 'hint err';
    return;
  }
  const delta = parseInt($('adjDelta').value, 10);
  if (!Number.isInteger(delta) || delta === 0) {
    hint.textContent = 'Change must be a non-zero number (use - to subtract)';
    hint.className = 'hint err';
    return;
  }
  const reason = $('adjReason').value.trim();
  if (!reason) { hint.textContent = 'A reason is required for a correction'; hint.className = 'hint err'; return; }
  const warehouseId = $('whSelect').value;
  if (!warehouseId) { hint.textContent = 'No warehouse selected'; hint.className = 'hint err'; return; }
  try {
    await api('/inventory/adjust', {
      method: 'POST',
      body: JSON.stringify({ skuId: sku.sku_id ?? sku.id, warehouseId, delta, reason }),
    });
    let onHand = '';
    try {
      const snaps = await api(`/inventory/on-hand/${sku.sku_id ?? sku.id}`);
      const s = snaps.find((x) => x.warehouse_id === warehouseId) || snaps[0];
      onHand = s ? ` (on hand ${s.quantity_on_hand})` : '';
    } catch { /* best effort */ }
    toast(`Adjusted ${sku.sku_code} by ${delta > 0 ? '+' : ''}${delta}${onHand}`);
    hint.textContent = ''; hint.className = 'hint';
    $('adjCode').value = ''; $('adjDelta').value = ''; $('adjReason').value = '';
  } catch (e) { hint.textContent = e.message; hint.className = 'hint err'; }
}
$('adjBtn').addEventListener('click', adjustStockUi);

// ---- fulfillment ----
// Drives a finalized-and-shipped sale end to end: finalize -> pick list ->
// pick each line -> ship. Every button maps to one existing API call. State is
// re-read from the server after each action, so the screen never drifts.
const fulfill = { sales: [], sale: null, pickList: null };

async function loadFulfillSales(preferId) {
  const sel = $('fulfillSelect');
  try {
    // Sales anywhere in the fulfillment-through-settlement lifecycle. Settled
    // sales stay listed so their reconciled breakdown remains reviewable.
    const all = await api('/sales');
    fulfill.sales = all.filter((s) =>
      ['open', 'finalized', 'picking', 'delivered', 'settled'].includes(s.status),
    );
    sel.innerHTML = '';
    if (!fulfill.sales.length) {
      const o = document.createElement('option');
      o.value = ''; o.textContent = 'No sales awaiting fulfillment';
      sel.appendChild(o);
      $('fulfillPanel').textContent = 'Nothing to fulfill right now.';
      return;
    }
    for (const s of fulfill.sales) {
      const o = document.createElement('option');
      o.value = s.id;
      o.textContent = `${s.organization_name} — ${s.name} (${s.status})`;
      sel.appendChild(o);
    }
    if (preferId && fulfill.sales.some((s) => s.id === preferId)) sel.value = preferId;
    renderFulfill(sel.value);
  } catch (e) {
    $('fulfillPanel').textContent = e.message;
  }
}

async function renderFulfill(saleId) {
  if (!saleId) return;
  const panel = $('fulfillPanel');
  panel.innerHTML = 'Loading…';
  try {
    const sale = await api(`/sales/${saleId}`);
    fulfill.sale = sale;
    let html = '';
    if (sale.status === 'open') {
      const orders = await api(`/sales/${saleId}/orders`);
      const total = orders.reduce((sum, o) => sum + centsOf(o.subtotal), 0);
      html += `<div class="ff-step"><h3>1. Finalize the sale</h3>` +
        `<div><strong>${orders.length}</strong> orders, <strong>${money(total)}</strong> raised.</div>` +
        (orders.length === 0
          ? `<div class="hint err">A sale needs at least one order to finalize.</div>`
          : `<div class="row" style="margin-top:10px">
               <label class="field"><span>Next sale date (optional)</span><input id="ffNextDate" type="date" /></label>
               <label class="field grow"><span>Incentive note (optional)</span><input id="ffIncentive" type="text" placeholder="e.g. free shipping next sale" /></label>
             </div>
             <div class="ff-actions"><button id="ffFinalize" class="btn primary">Finalize sale</button></div>`) +
        `</div>`;
    } else {
      html += `<div class="ff-step"><h3>1. Finalize the sale</h3><span class="ff-badge ok">Finalized</span></div>`;
    }

    if (sale.status === 'finalized' || sale.status === 'picking') {
      html += `<div class="ff-step"><h3>2. Pick list</h3><div id="ffPickArea">Loading pick list…</div></div>`;
    }

    // Once delivered, the bulk shipment is out. Show the packing slip and the
    // settle step (which computes payouts and accrues commissions).
    if (sale.status === 'delivered' || sale.status === 'settled') {
      html += `<div class="ff-step"><h3>2. Shipped</h3><span class="ff-badge ok">Delivered</span>
        <div class="ff-actions"><button id="ffSlip" class="btn ghost" type="button">View packing slip</button></div>
        <div id="ffSlipArea"></div></div>`;
      html += `<div class="ff-step"><h3>3. Settle &amp; pay</h3><div id="ffSettleArea">Loading…</div></div>`;
    }

    panel.innerHTML = html;

    if ($('ffFinalize')) $('ffFinalize').addEventListener('click', () => doFinalize(saleId));
    if (sale.status === 'finalized' || sale.status === 'picking') await renderPickArea(saleId, sale.status);
    if (sale.status === 'delivered' || sale.status === 'settled') {
      $('ffSlip').addEventListener('click', () => showPackingSlip(saleId));
      await renderSettleArea(saleId, sale.status);
    }
  } catch (e) {
    panel.textContent = e.message;
  }
}

async function showPackingSlip(saleId) {
  const area = $('ffSlipArea');
  area.innerHTML = 'Loading…';
  try {
    const pl = await api(`/sales/${saleId}/pick-list`);
    if (!pl) { area.textContent = 'No pick list on file.'; return; }
    const slip = await api(`/pick-lists/${pl.pick_list_id}/packing-slip`);
    const addr = [slip.address_line1, slip.address_city, slip.address_state, slip.address_postal]
      .filter(Boolean).join(', ');
    area.innerHTML = `<div class="slip">
      <div><strong>${slip.pick_list_number}</strong> — ${slip.sale_name}</div>
      <div class="muted">Ship to ${slip.organization_name}${addr ? ' — ' + addr : ''}</div>
      ${slip.shipment ? `<div class="muted">${slip.shipment.carrier || ''} ${slip.shipment.tracking_number || ''}</div>` : ''}
      ${tableHtml(['SKU', 'Description', 'Required', 'Picked'],
        slip.lines.map((l) => [l.sku_code, l.description || '', l.quantity_required, l.quantity_picked]))}
    </div>`;
  } catch (e) { area.textContent = e.message; }
}

async function renderSettleArea(saleId, status) {
  const area = $('ffSettleArea');
  try {
    if (status === 'delivered') {
      area.innerHTML = `<div>Settle this sale to compute payouts and accrue commissions.</div>` +
        `<div class="ff-actions"><button id="ffSettle" class="btn primary">Settle sale</button></div>`;
      $('ffSettle').addEventListener('click', async () => {
        try {
          await api(`/sales/${saleId}/settle`, { method: 'POST' });
          toast('Sale settled');
          loadFulfillSales(saleId);
        } catch (e) { toast('Settle failed: ' + e.message); }
      });
      return;
    }
    // settled: show the reconciled breakdown, read-only.
    const s = await api(`/sales/${saleId}/settlement`);
    area.innerHTML = `<span class="ff-badge ok">Settled</span>` +
      tableHtml(['Line', 'Amount'], [
        ['Gross revenue', usd(s.gross_revenue)],
        ['Organization payout', usd(s.organization_payout)],
        ['Distributor commission', usd(s.distributor_commission)],
        ['Seller commission', usd(s.seller_commission)],
        ['Product cost', usd(s.product_cost_total)],
        ['Gross profit', usd(s.gross_profit)],
      ]) +
      `<div class="muted" style="margin-top:8px">Commissions accrued. Approve and pay them in the Payouts tab.</div>`;
  } catch (e) { area.textContent = e.message; }
}

async function doFinalize(saleId) {
  const nextDate = $('ffNextDate') && $('ffNextDate').value;
  const incentive = $('ffIncentive') && $('ffIncentive').value.trim();
  const body = { finalizedBy: 'portal' };
  if (nextDate) body.nextSaleTarget = nextDate;
  if (incentive) body.incentiveNote = incentive;
  try {
    await api(`/sales/${saleId}/finalize`, { method: 'POST', body: JSON.stringify(body) });
    toast('Sale finalized');
    loadFulfillSales(saleId);
  } catch (e) { toast('Finalize failed: ' + e.message); }
}

async function renderPickArea(saleId, status) {
  const area = $('ffPickArea');
  try {
    if (status === 'finalized') {
      area.innerHTML = `<div>Ready to generate the bulk pick list.</div>` +
        `<div class="ff-actions"><button id="ffGenPick" class="btn primary">Generate pick list</button></div>`;
      $('ffGenPick').addEventListener('click', async () => {
        try {
          const pl = await api(`/sales/${saleId}/pick-list`, { method: 'POST' });
          fulfill.pickList = pl;
          toast('Pick list ' + pl.pick_list_number);
          renderFulfill(saleId);
        } catch (e) { toast('Pick list failed: ' + e.message); }
      });
      return;
    }
    // status === 'picking': show the pick list lines with pick + ship controls.
    // Always re-read from the server so the screen survives a reload and never
    // drifts from the ledger.
    const pl = await api(`/sales/${saleId}/pick-list`);
    fulfill.pickList = pl;
    if (!pl) {
      area.innerHTML = `<div class="hint">No pick list found for this sale.</div>`;
      return;
    }
    const rows = pl.lines.map((l) => {
      const remaining = l.quantity_required - l.quantity_picked;
      const badge = l.short
        ? `<span class="ff-badge short">short ${l.shortage}</span>`
        : `<span class="ff-badge ok">on hand ${l.quantity_on_hand}</span>`;
      return `<tr>
        <td><code>${l.sku_code}</code></td>
        <td class="num">${l.quantity_picked}/${l.quantity_required}</td>
        <td>${badge}</td>
        <td>${remaining > 0
          ? `<button class="btn ff-pick" data-line="${l.id}" data-remaining="${remaining}">Pick ${remaining}</button>`
          : `<span class="ff-badge ok">picked</span>`}</td>
      </tr>`;
    }).join('');
    const allPicked = pl.lines.every((l) => l.quantity_picked >= l.quantity_required);
    area.innerHTML = `<div class="muted" style="margin-bottom:8px">${pl.pick_list_number}</div>` +
      `<table class="lines"><thead><tr><th>Code</th><th class="num">Picked</th><th>Stock</th><th></th></tr></thead><tbody>${rows}</tbody></table>` +
      `<div class="ff-step"><h3>3. Ship to the team</h3>
         <div class="row">
           <label class="field"><span>Carrier (optional)</span><input id="ffCarrier" type="text" placeholder="e.g. UPS" /></label>
           <label class="field grow"><span>Tracking number (optional)</span><input id="ffTracking" type="text" /></label>
         </div>
         <div class="ff-actions">
           <button id="ffShip" class="btn primary" ${allPicked ? '' : 'disabled title="Pick all lines first"'}>Ship one delivery</button>
         </div>
         ${allPicked ? '' : '<div class="hint">Pick every line to enable shipping.</div>'}
       </div>`;

    area.querySelectorAll('.ff-pick').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const lineId = btn.getAttribute('data-line');
        const remaining = parseInt(btn.getAttribute('data-remaining'), 10);
        try {
          await api(`/pick-list-lines/${lineId}/pick`, {
            method: 'POST',
            body: JSON.stringify({ quantityPicked: remaining }),
          });
          toast('Picked ' + remaining);
          // renderPickArea re-reads the pick list from the server.
          renderPickArea(saleId, 'picking');
        } catch (e) { toast('Pick failed: ' + e.message); }
      });
    });
    if ($('ffShip')) {
      $('ffShip').addEventListener('click', async () => {
        const carrier = $('ffCarrier').value.trim();
        const tracking = $('ffTracking').value.trim();
        const body = {};
        if (carrier) body.carrier = carrier;
        if (tracking) body.trackingNumber = tracking;
        try {
          await api(`/pick-lists/${pl.pick_list_id}/complete`, { method: 'POST' });
          await api(`/pick-lists/${pl.pick_list_id}/ship`, { method: 'POST', body: JSON.stringify(body) });
          toast('Shipped to the team');
          fulfill.pickList = null;
          loadFulfillSales(saleId);
        } catch (e) { toast('Ship failed: ' + e.message); }
      });
    }
  } catch (e) { area.textContent = e.message; }
}

$('fulfillSelect').addEventListener('change', (e) => renderFulfill(e.target.value));
$('fulfillReload').addEventListener('click', () => loadFulfillSales());

// ---- owner dashboard ----
// One read-only call. The money strings from the server are shown as-is (never
// re-parsed to a float); only whole-dollar display formatting is applied.
function usd(str) {
  const n = Number(str);
  return '$' + n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

const dashData = { inventory: [], customers: [] };

async function loadDashboard() {
  try {
    const [d, inventory, customers] = await Promise.all([
      api('/dashboard/summary'),
      api('/inventory'),
      api('/customers'),
    ]);
    dashData.inventory = inventory;
    dashData.customers = customers;
    const h = d.headline;
    $('dashStats').innerHTML = [
      stat(usd(h.revenue), 'Revenue'),
      stat(usd(h.gross_margin), 'Gross margin'),
      stat(h.units, 'Units sold'),
      stat(h.order_count, 'Orders'),
      stat(h.active_teams, 'Active teams'),
      stat(d.inventory.on_hand_units, 'On-hand units'),
      stat(d.inventory.reorder_alerts, 'Reorder alerts', Number(d.inventory.reorder_alerts) > 0),
      stat(d.inventory.negative_lines, 'Negative stock', Number(d.inventory.negative_lines) > 0),
      stat(String(customers.length), 'Clients'),
    ].join('');

    $('dashMargin').innerHTML = d.by_entity_channel.length
      ? tableHtml(['Entity', 'Channel', 'Revenue', 'Margin'],
          d.by_entity_channel.map((r) => [r.owner_entity, r.channel, usd(r.revenue), usd(r.gross_margin)]))
      : 'No revenue yet.';

    $('dashPipeline').innerHTML = d.pipeline.length
      ? tableHtml(['Status', 'Sales'], d.pipeline.map((p) => [p.status, p.sales]))
      : 'No sales yet.';

    $('dashReorder').innerHTML = d.reorder_alerts.length
      ? tableHtml(['SKU', 'Available', 'Reorder at', 'Suggest'],
          d.reorder_alerts.map((r) => [r.sku_code, r.available, r.reorder_point, r.suggested_order]))
      : 'Nothing to reorder. Run the forecast if this looks empty.';

    $('dashSellers').innerHTML = d.top_sellers.length
      ? tableHtml(['Seller', 'Units', 'Revenue'],
          d.top_sellers.map((s) => [s.display_name || s.seller_code, s.units, usd(s.revenue)]))
      : 'No seller credit yet.';

    // Inventory on hand: negatives are a discrepancy, flag them in red.
    $('dashInventory').innerHTML = inventory.length
      ? tableHtml(['SKU', 'On hand', 'Committed', 'Available'],
          inventory.map((i) => [
            i.sku_code,
            i.on_hand < 0 ? `<span style="color:var(--danger)">${i.on_hand}</span>` : i.on_hand,
            i.committed,
            i.available,
          ]))
      : 'No SKUs yet.';

    // Master client list: every buyer across every team, deduped.
    $('dashCustomers').innerHTML = customers.length
      ? tableHtml(['Client', 'Teams', 'Last order'],
          customers.map((c) => [c.display_name || '(no name)', c.teams, fmtDate(c.last_order_at)]))
      : 'No clients yet.';
  } catch (e) {
    $('dashStats').textContent = e.message;
  }
}

function stat(val, lbl, warn) {
  return `<div class="stat${warn ? ' warn' : ''}"><div class="val">${val}</div><div class="lbl">${lbl}</div></div>`;
}

$('dashReload').addEventListener('click', () => loadDashboard());
$('expInventory').addEventListener('click', () =>
  downloadCsv('inventory.csv', ['SKU', 'On hand', 'Committed', 'Available'],
    dashData.inventory.map((i) => [i.sku_code, i.on_hand, i.committed, i.available])));
$('expCustomers').addEventListener('click', () =>
  downloadCsv('master-client-list.csv', ['Client', 'Email', 'Phone', 'Teams', 'First order', 'Last order'],
    dashData.customers.map((c) => [c.display_name || '', c.email || '', c.phone || '', c.teams, fmtDate(c.first_order_at), fmtDate(c.last_order_at)])));

// ---- payouts ----
// The commission payout run: accrued -> approved -> paid. Each row shows the
// one action available for its state, so the lifecycle is enforced by the UI as
// well as the API.
let payoutRows = [];
async function loadPayouts() {
  const area = $('payList');
  const status = $('payStatus').value;
  area.innerHTML = 'Loading…';
  try {
    const rows = await api('/commissions' + (status ? `?status=${status}` : ''));
    payoutRows = rows;
    if (!rows.length) { area.textContent = 'No commissions for this filter.'; return; }
    const head = '<tr><th>Payee</th><th>Type</th><th>Sale</th><th class="num">Amount</th><th>Status</th><th></th></tr>';
    const body = rows.map((c) => {
      let action = '';
      if (c.status === 'accrued') action = `<button class="btn pay-approve" data-id="${c.id}">Approve</button>`;
      else if (c.status === 'approved') action = `<button class="btn primary pay-pay" data-id="${c.id}">Pay</button>`;
      else action = `<span class="ff-badge ok">paid</span>`;
      return `<tr>
        <td>${c.payee_name || '(unknown)'}</td>
        <td>${c.payee_type}</td>
        <td>${c.campaign_name || ''}</td>
        <td class="num">${usd(c.amount)}</td>
        <td>${c.status}</td>
        <td>${action}</td>
      </tr>`;
    }).join('');
    area.innerHTML = `<table>${head}${body}</table>`;

    area.querySelectorAll('.pay-approve').forEach((b) =>
      b.addEventListener('click', () => payAction(b.getAttribute('data-id'), 'approve')));
    area.querySelectorAll('.pay-pay').forEach((b) =>
      b.addEventListener('click', () => payAction(b.getAttribute('data-id'), 'pay')));
  } catch (e) {
    area.textContent = e.message;
  }
}

async function payAction(id, action) {
  try {
    await api(`/commissions/${id}/${action}`, { method: 'POST' });
    toast(action === 'approve' ? 'Approved' : 'Marked paid');
    loadPayouts();
  } catch (e) { toast('Failed: ' + e.message); }
}

$('payStatus').addEventListener('change', () => loadPayouts());
$('payReload').addEventListener('click', () => loadPayouts());
$('expPayouts').addEventListener('click', () =>
  downloadCsv('payouts.csv', ['Payee', 'Type', 'Sale', 'Amount', 'Status'],
    payoutRows.map((c) => [c.payee_name || '', c.payee_type, c.campaign_name || '', c.amount, c.status])));

// ---- sales admin ----
// The front of the operational funnel: create a sale for a team, choose the
// products it offers, and open it so Order entry can take orders. A new sale
// locks to the active commission plan on the server (rule 3).
async function loadSalesAdmin() {
  try {
    const [orgs, skus, sales] = await Promise.all([
      api('/organizations'),
      api('/skus'),
      api('/sales'),
    ]);
    const orgSel = $('nsOrg');
    orgSel.innerHTML = '';
    if (!orgs.length) {
      const o = document.createElement('option');
      o.value = ''; o.textContent = 'No teams yet (onboard via GoHighLevel)';
      orgSel.appendChild(o);
    }
    for (const o of orgs) {
      const opt = document.createElement('option');
      opt.value = o.id; opt.textContent = o.name;
      orgSel.appendChild(opt);
    }

    $('nsSkus').innerHTML = skus.length
      ? skus.map((s) => `<label class="ns-row">
          <input type="checkbox" class="ns-check" data-sku="${s.sku_id ?? s.id}" />
          <span class="ns-label"><code>${s.sku_code}</code> ${s.product_name || ''}</span>
          <input type="text" class="ns-override" inputmode="decimal" placeholder="${Number(s.retail_price).toFixed(2)}" data-sku="${s.sku_id ?? s.id}" />
        </label>`).join('')
      : 'No SKUs. Add products in the Catalog tab first.';

    renderSalesList(sales);
  } catch (e) {
    $('nsHint').textContent = e.message;
    $('nsHint').className = 'hint err';
  }
}

function renderSalesList(sales) {
  const el = $('nsList');
  if (!sales.length) { el.textContent = 'No sales yet.'; return; }
  const head = '<tr><th>Team</th><th>Sale</th><th>Status</th><th></th></tr>';
  const body = sales.map((s) => {
    const action = s.status === 'draft'
      ? `<button class="btn ns-open" data-id="${s.id}">Open</button>`
      : '';
    return `<tr><td>${s.organization_name || ''}</td><td>${s.name}</td><td>${s.status}</td><td>${action}</td></tr>`;
  }).join('');
  el.innerHTML = `<table>${head}${body}</table>`;
  el.querySelectorAll('.ns-open').forEach((b) =>
    b.addEventListener('click', () => openSaleById(b.getAttribute('data-id'))));
}

async function openSaleById(id) {
  try {
    await api(`/sales/${id}/open`, { method: 'POST' });
    toast('Sale opened');
    loadSalesAdmin();
    loadSales().catch(() => {}); // refresh the Order entry dropdown
  } catch (e) { toast('Open failed: ' + e.message); }
}

async function createSale() {
  const hint = $('nsHint');
  const organizationId = $('nsOrg').value;
  const name = $('nsName').value.trim();
  if (!organizationId) { hint.textContent = 'Pick a team first'; hint.className = 'hint err'; return; }
  if (!name) { hint.textContent = 'Sale name is required'; hint.className = 'hint err'; return; }
  const checks = [...document.querySelectorAll('.ns-check')].filter((c) => c.checked);
  if (!checks.length) { hint.textContent = 'Check at least one product'; hint.className = 'hint err'; return; }
  const skusPayload = checks.map((c) => {
    const skuId = c.getAttribute('data-sku');
    const ov = document.querySelector(`.ns-override[data-sku="${skuId}"]`);
    const priceOverride = ov && ov.value.trim();
    return priceOverride ? { skuId, priceOverride } : { skuId };
  });
  const body = { organizationId, name, skus: skusPayload };
  const goal = $('nsGoal').value.trim();
  if (goal) body.goalAmount = goal;
  try {
    const sale = await api('/sales', { method: 'POST', body: JSON.stringify(body) });
    if ($('nsOpen').checked) await api(`/sales/${sale.id}/open`, { method: 'POST' });
    toast($('nsOpen').checked ? 'Sale created and opened' : 'Sale created (draft)');
    hint.textContent = ''; hint.className = 'hint';
    $('nsName').value = ''; $('nsGoal').value = '';
    [...document.querySelectorAll('.ns-check')].forEach((c) => (c.checked = false));
    [...document.querySelectorAll('.ns-override')].forEach((o) => (o.value = ''));
    loadSalesAdmin();
    loadSales().catch(() => {}); // an opened sale shows up in Order entry
  } catch (e) { hint.textContent = e.message; hint.className = 'hint err'; }
}

$('nsCreate').addEventListener('click', createSale);

// ---- catalog admin ----
// Staff set up the products and SKUs the receiving screen scans against. The
// custom stack owns the catalog (not GHL), so this is the place to add one.
async function loadCatalog() {
  try {
    const [products, skus] = await Promise.all([api('/products'), api('/skus')]);
    // Product picker for the Add SKU form.
    const sel = $('sProduct');
    sel.innerHTML = '';
    for (const p of products) {
      const o = document.createElement('option');
      o.value = p.id; o.textContent = `${p.name} (${p.category})`;
      sel.appendChild(o);
    }
    $('catProducts').innerHTML = products.length
      ? tableHtml(['Name', 'Brand', 'Category'], products.map((p) => [p.name, p.brand, p.category]))
      : 'No products yet.';
    $('catSkus').innerHTML = skus.length
      ? tableHtml(['Code', 'Product', 'QR', 'Price'],
          skus.map((s) => [s.sku_code, s.product_name || '', s.qr_code || '—', usd(s.retail_price)]))
      : 'No SKUs yet.';
  } catch (e) {
    $('catProducts').textContent = e.message;
  }
}

async function addProduct() {
  const hint = $('pHint');
  const name = $('pName').value.trim();
  const brand = $('pBrand').value.trim();
  const ownerEntity = $('pOwner').value.trim();
  if (!name || !brand || !ownerEntity) {
    hint.textContent = 'Name, brand, and owner entity are required';
    hint.className = 'hint err';
    return;
  }
  try {
    await api('/products', {
      method: 'POST',
      body: JSON.stringify({ name, brand, category: $('pCategory').value, ownerEntity }),
    });
    toast(`Added ${name}`);
    hint.textContent = ''; hint.className = 'hint';
    $('pName').value = ''; $('pBrand').value = '';
    loadCatalog();
  } catch (e) { hint.textContent = e.message; hint.className = 'hint err'; }
}

async function addSku() {
  const hint = $('sHint');
  const productId = $('sProduct').value;
  const skuCode = $('sCode').value.trim();
  if (!productId) { hint.textContent = 'Add a product first'; hint.className = 'hint err'; return; }
  if (!skuCode) { hint.textContent = 'SKU code is required'; hint.className = 'hint err'; return; }
  const body = { productId, skuCode };
  const qr = $('sQr').value.trim(); if (qr) body.qrCode = qr;
  const price = $('sPrice').value.trim(); if (price) body.retailPrice = price;
  const cost = $('sCost').value.trim(); if (cost) body.productCost = cost;
  const config = $('sConfig').value.trim(); if (config) body.unitConfig = config;
  try {
    await api('/skus', { method: 'POST', body: JSON.stringify(body) });
    toast(`Added SKU ${skuCode}`);
    hint.textContent = ''; hint.className = 'hint';
    $('sCode').value = ''; $('sQr').value = ''; $('sPrice').value = ''; $('sCost').value = ''; $('sConfig').value = '';
    loadCatalog();
    // A new SKU is immediately scannable in Receiving; refresh its catalog too.
    recv.loaded = false;
  } catch (e) { hint.textContent = e.message; hint.className = 'hint err'; }
}

$('pAdd').addEventListener('click', addProduct);
$('sAdd').addEventListener('click', addSku);

// ---- boot ----
loadSales().catch((e) => toast(e.message));
if ('serviceWorker' in navigator) navigator.serviceWorker.register('/app/sw.js').catch(() => {});

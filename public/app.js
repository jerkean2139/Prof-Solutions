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
    if (tab.dataset.view === 'receive') initReceiving();
    if (tab.dataset.view === 'fulfill') loadFulfillSales();
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

// ---- fulfillment ----
// Drives a finalized-and-shipped sale end to end: finalize -> pick list ->
// pick each line -> ship. Every button maps to one existing API call. State is
// re-read from the server after each action, so the screen never drifts.
const fulfill = { sales: [], sale: null, pickList: null };

async function loadFulfillSales() {
  const sel = $('fulfillSelect');
  try {
    // Sales that still have fulfillment work: open, finalized, or picking.
    const all = await api('/sales');
    fulfill.sales = all.filter((s) => ['open', 'finalized', 'picking'].includes(s.status));
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
    panel.innerHTML = html;

    if ($('ffFinalize')) $('ffFinalize').addEventListener('click', () => doFinalize(saleId));
    if (sale.status === 'finalized' || sale.status === 'picking') await renderPickArea(saleId, sale.status);
  } catch (e) {
    panel.textContent = e.message;
  }
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
    renderFulfill(saleId);
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
          loadFulfillSales();
        } catch (e) { toast('Ship failed: ' + e.message); }
      });
    }
  } catch (e) { area.textContent = e.message; }
}

$('fulfillSelect').addEventListener('change', (e) => renderFulfill(e.target.value));
$('fulfillReload').addEventListener('click', () => loadFulfillSales());

// ---- boot ----
loadSales().catch((e) => toast(e.message));
if ('serviceWorker' in navigator) navigator.serviceWorker.register('/app/sw.js').catch(() => {});

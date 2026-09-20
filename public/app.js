(function () {
  'use strict';
  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => Array.from(r.querySelectorAll(s));

  let SETTINGS = { currency: 'ر.س', vat_rate: '15', business_name: 'لاكي سكاي' };
  const state = { route: 'dashboard', shopId: null, selected: new Set(), payMethod: 'cash', filter: 'all' };

  const nfmt = new Intl.NumberFormat('en-US', { minimumFractionDigits: 0, maximumFractionDigits: 2 });
  const money = (n) => nfmt.format(Number(n) || 0);
  const cur = () => SETTINGS.currency || '';
  const esc = (s) => (s == null ? '' : String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'));

  function toast(msg, type) {
    const t = $('#toast'); t.textContent = msg; t.className = 'toast ' + (type || '');
    clearTimeout(t._t); t._t = setTimeout(() => t.classList.add('hidden'), 2600);
  }

  async function api(path, options = {}) {
    const opt = { credentials: 'same-origin', ...options };
    if (opt.body && !(opt.body instanceof FormData)) {
      opt.headers = { 'Content-Type': 'application/json', ...(opt.headers || {}) };
      opt.body = JSON.stringify(opt.body);
    }
    const res = await fetch('/api' + path, opt);
    if (res.status === 401) { showLogin(); throw new Error('unauthorized'); }
    const ct = res.headers.get('content-type') || '';
    const data = ct.includes('json') ? await res.json().catch(() => ({})) : res;
    if (!res.ok) throw new Error((data && data.error) || 'حدث خطأ');
    return data;
  }

  // ===== الشاشات =====
  function showLogin() { $('#login-screen').classList.remove('hidden'); $('#app').classList.add('hidden'); }
  function showApp() { $('#login-screen').classList.add('hidden'); $('#app').classList.remove('hidden'); }

  $('#login-form').addEventListener('submit', async (e) => {
    e.preventDefault(); $('#login-error').textContent = '';
    try { await api('/login', { method: 'POST', body: { password: $('#password').value } }); $('#password').value = ''; showApp(); navigate('dashboard'); }
    catch (err) { $('#login-error').textContent = err.message; }
  });
  $('#logout-btn').addEventListener('click', async () => { await api('/logout', { method: 'POST' }).catch(()=>{}); showLogin(); });

  // ===== التنقل =====
  function navigate(route, params = {}) {
    state.route = route;
    if (params.shopId != null) { state.shopId = params.shopId; state.selected = new Set(); state.filter = 'all'; }
    $$('.nav-item').forEach((n) => n.classList.toggle('active', n.dataset.route === route));
    // روابط قابلة للحفظ/المشاركة بين الأجهزة
    const hash = route === 'shop' && state.shopId != null ? `#/shop/${state.shopId}` : `#/${route}`;
    if (location.hash !== hash) history.replaceState(null, '', hash);
    render();
  }
  function routeFromHash() {
    const m = (location.hash || '').match(/#\/shop\/(\d+)/);
    if (m) return { route: 'shop', shopId: m[1] };
    const r = (location.hash || '').replace('#/', '');
    if (['dashboard','shops','reports','import','backups','audit','settings'].includes(r)) return { route: r };
    return { route: 'dashboard' };
  }
  window.addEventListener('hashchange', () => { const r = routeFromHash(); navigate(r.route, r.shopId ? { shopId: r.shopId } : {}); });
  $$('.nav-item').forEach((n) => n.addEventListener('click', () => navigate(n.dataset.route)));

  function render() {
    const v = $('#view'); v.innerHTML = '<div class="loading">جارٍ التحميل…</div>';
    ({ dashboard: renderDashboard, shops: renderShops, shop: renderShop, reports: renderReports, import: renderImport, backups: renderBackups, audit: renderAudit, settings: renderSettings }[state.route] || renderDashboard)();
  }

  // ===== لوحة التحكم =====
  async function renderDashboard() {
    const d = await api('/dashboard');
    SETTINGS = d.settings || SETTINGS;
    const v = $('#view');
    v.innerHTML = `
      <div class="topbar" style="margin:-24px -26px 22px; position:static;">
        <div class="page-title">لوحة التحكم<small>نظرة عامة على الديون والحركات</small></div>
        <div class="topbar-actions">
          <div class="searchbar clickable" id="go-search">🔍 ابحث عن محل…</div>
          <button class="btn btn-ghost" id="qp">＋ تسجيل دفعة</button>
          <button class="btn btn-green" id="qs">＋ محل جديد</button>
        </div>
      </div>
      <div class="kpis">
        <div class="kpi accent"><div class="ic">💰</div><div class="label">إجمالي الديون المستحقة</div><div class="value">${money(d.totalDebt)}<span class="cur">${cur()}</span></div></div>
        <div class="kpi"><div class="ic">✅</div><div class="label">المُسدّد هذا الشهر</div><div class="value">${money(d.monthPaid)}<span class="cur">${cur()}</span></div></div>
        <div class="kpi"><div class="ic">📤</div><div class="label">ديون جديدة هذا الشهر</div><div class="value">${money(d.monthNewDebts)}<span class="cur">${cur()}</span></div></div>
        <div class="kpi"><div class="ic">🏬</div><div class="label">المحلات المدينة</div><div class="value">${money(d.debtorsCount)}</div><div class="trend">من أصل ${money(d.shopsCount)} محل</div></div>
      </div>
      <div class="grid-2">
        <div class="card">
          <div class="card-head"><h3>🏆 المحلات الأعلى ديناً (بالترتيب)</h3><button class="btn btn-soft btn-sm" id="all-shops">عرض كل المحلات</button></div>
          <div class="card-body" id="top-shops"></div>
        </div>
        <div class="card">
          <div class="card-head"><h3>🔁 أحدث الحركات</h3></div>
          <div class="card-body"><table><tbody id="recent"></tbody></table></div>
        </div>
      </div>
      <div class="grid-2">
        <div class="card">
          <div class="card-head"><h3>📈 الديون والمُسدّد — آخر 6 أشهر</h3></div>
          <div class="card-body" style="padding:16px">${miniChart(d.series||[])}</div>
        </div>
        <div class="card">
          <div class="card-head"><h3>🔔 تنبيهات المتأخرين</h3></div>
          <div class="card-body" id="alerts"></div>
        </div>
      </div>`;

    const maxBal = Math.max(1, ...d.topShops.map((s) => s.balance));
    $('#top-shops').innerHTML = d.topShops.length ? d.topShops.map((s, i) => `
      <div class="shop-rank" data-shop="${s.id}">
        <div class="rank-num ${i===0?'top':''}">${i+1}</div>
        <div class="shop-av">${esc((s.name||'؟').slice(0,2))}</div>
        <div class="shop-meta"><div class="nm">${esc(s.name)}</div>
          <div class="sub">آخر حركة: ${esc(s.lastDate||'—')} • ${money(s.entriesCount)} حركة</div>
          <div class="bar-track"><div class="bar-fill" style="width:${Math.max(4,(s.balance/maxBal)*100)}%"></div></div>
        </div>
        <div class="shop-amt"><div class="big">${money(s.balance)}</div><div class="lbl">${cur()} مستحق</div></div>
      </div>`).join('') : '<div class="empty">لا توجد محلات بعد. أضف محلاً أو استورد من إكسل.</div>';
    $$('#top-shops .shop-rank').forEach((r) => r.addEventListener('click', () => navigate('shop', { shopId: r.dataset.shop })));

    const kindBadge = { item: '<span class="badge b-due">دين</span>', payment: '<span class="badge b-paid">دفعة</span>', return: '<span class="badge b-ret">مرتجع</span>' };
    $('#recent').innerHTML = d.recent.length ? d.recent.map((e) => {
      const sign = e.kind === 'payment' || e.kind === 'return' ? '-' : (e.status==='invoiced'?'':'+');
      const cls = e.kind === 'payment' ? 'paid' : e.kind === 'return' ? 'ret' : 'due';
      return `<tr class="clickable" data-shop="${e.shop_id}"><td>${kindBadge[e.kind]||''}</td><td>${esc(e.shop_name)}<div class="sub">${esc(e.description||e.payment_method||'')}</div></td><td class="amount ${cls} num">${sign}${money(e.amount)}</td></tr>`;
    }).join('') : '<tr><td class="empty">لا حركات</td></tr>';
    $$('#recent tr[data-shop]').forEach((r) => r.addEventListener('click', () => navigate('shop', { shopId: r.dataset.shop })));

    // تنبيهات المتأخرين مع زر تذكير واتساب
    const al = $('#alerts');
    al.innerHTML = (d.alerts && d.alerts.length) ? d.alerts.map((a) => `
      <div class="shop-rank" style="cursor:default">
        <div class="shop-av" style="background:var(--due-050);color:var(--due);border-color:var(--due-050)">!</div>
        <div class="shop-meta"><div class="nm">${esc(a.name)}</div>
          <div class="sub">${a.overLimit?'تجاوز الحد الائتماني • ':''}${a.overdue?('متأخر '+a.days+' يوم'):''}</div></div>
        <div style="display:flex;gap:6px;align-items:center">
          <div class="shop-amt"><div class="big">${money(a.balance)}</div><div class="lbl">${cur()}</div></div>
          <button class="btn btn-green btn-sm wa-btn" data-phone="${esc(a.phone)}" data-name="${esc(a.name)}" data-bal="${a.balance}">📲 تذكير</button>
        </div>
      </div>`).join('') : '<div class="empty">لا يوجد متأخرون 👍</div>';
    $$('#alerts .wa-btn').forEach((b) => b.addEventListener('click', () => {
      waSend(b.dataset.phone, `السلام عليكم، تذكير ودّي من ${SETTINGS.business_name}: الرصيد المستحق على حسابكم ${money(b.dataset.bal)} ${cur()}. نأمل ترتيب السداد، وشكراً لتعاملكم.`);
    }));

    $('#qs').addEventListener('click', () => openShopModal());
    $('#all-shops').addEventListener('click', () => navigate('shops'));
    $('#go-search').addEventListener('click', () => navigate('shops'));
    $('#qp').addEventListener('click', () => navigate('shops'));
  }

  // ===== قائمة المحلات =====
  async function renderShops() {
    const v = $('#view');
    v.innerHTML = `
      <div class="topbar" style="margin:-24px -26px 22px; position:static;">
        <div class="page-title">المحلات<small>كل المحلات مرتّبة حسب الدين</small></div>
        <div class="topbar-actions">
          <div class="searchbar"><input id="shop-search" placeholder="ابحث بالاسم أو الهاتف أو الكود…" style="border:none;background:none;margin:0;padding:0;min-width:220px" /></div>
          <button class="btn btn-green" id="add-shop">＋ محل جديد</button>
        </div>
      </div>
      <div class="card"><div class="card-body"><table>
        <thead><tr><th>#</th><th>المحل</th><th>الكود</th><th>الهاتف</th><th>الرصيد المستحق</th><th></th></tr></thead>
        <tbody id="shops-body"></tbody></table><div id="shops-empty" class="empty hidden">لا توجد محلات.</div></div></div>`;

    async function load() {
      const q = $('#shop-search').value.trim();
      const shops = await api('/shops' + (q ? '?search=' + encodeURIComponent(q) : ''));
      $('#shops-empty').classList.toggle('hidden', shops.length > 0);
      $('#shops-body').innerHTML = shops.map((s, i) => `
        <tr class="clickable" data-shop="${s.id}">
          <td>${i+1}</td><td class="nm" style="font-weight:800">${esc(s.name)}</td>
          <td class="code">${esc(s.code)||'—'}</td><td>${esc(s.phone)||'—'}</td>
          <td class="amount ${s.balance>0.001?'due':'paid'} num">${money(s.balance)} ${cur()}</td>
          <td>عرض ‹</td></tr>`).join('');
      $$('#shops-body tr[data-shop]').forEach((r) => r.addEventListener('click', () => navigate('shop', { shopId: r.dataset.shop })));
    }
    let t; $('#shop-search').addEventListener('input', () => { clearTimeout(t); t = setTimeout(load, 250); });
    $('#add-shop').addEventListener('click', () => openShopModal(null, load));
    load();
  }

  // ===== صفحة المحل =====
  async function renderShop() {
    const d = await api('/shops/' + state.shopId + '?filter=' + state.filter);
    SETTINGS = d.settings || SETTINGS;
    const t = d.totals, vat = d.vat;
    const v = $('#view');
    v.innerHTML = `
      <div class="topbar" style="margin:-24px -26px 22px; position:static;">
        <div class="page-title">${esc(d.name)}<small><span class="back-link" id="back">‹ رجوع للمحلات</span> • ${esc(d.code)?('كود: '+esc(d.code)):''} ${esc(d.phone)?('• '+esc(d.phone)):''}</small></div>
        <div class="topbar-actions"><button class="btn btn-green" id="wa-remind">📲 تذكير واتساب</button><button class="btn btn-ghost" id="print-statement">🖨️ كشف حساب PDF</button><button class="btn btn-ghost" id="edit-shop">تعديل</button></div>
      </div>
      ${(d.overLimit || (d.aging && d.aging.days > 60)) ? `<div class="card" style="margin-bottom:14px;border-color:var(--due);background:var(--due-050)"><div class="card-body" style="padding:12px 16px;color:var(--due);font-weight:700">${d.overLimit?`⚠️ تجاوز الحد الائتماني (${money(d.credit_limit)} ${cur()}). `:''}${(d.aging&&d.aging.days>60)?`⏳ أقدم دين غير مسدّد منذ ${d.aging.days} يوم (${esc(d.aging.oldest)}).`:''}</div></div>`:''}
      <div class="kpis">
        <div class="kpi accent"><div class="ic">💰</div><div class="label">الرصيد المستحق الآن</div><div class="value">${money(t.balance)}<span class="cur">${cur()}</span></div></div>
        <div class="kpi"><div class="ic">✅</div><div class="label">إجمالي المسدد</div><div class="value amount paid">${money(t.payments)}<span class="cur">${cur()}</span></div></div>
        <div class="kpi"><div class="ic">↩️</div><div class="label">بضاعة مرتجعة</div><div class="value">${money(t.returns)}<span class="cur">${cur()}</span></div></div>
        <div class="kpi"><div class="ic">🧾</div><div class="label">بفواتير خارجية</div><div class="value">${money(t.invoiced)}<span class="cur">${cur()}</span></div></div>
      </div>

      <div class="card" style="margin-top:18px;"><div class="card-body" style="padding:16px 18px; display:flex; align-items:center; gap:12px; flex-wrap:wrap;">
        <button class="btn btn-green" id="a-item">＋ إضافة بضاعة (دين)</button>
        <button class="btn btn-ghost" id="a-pay">💵 تسجيل دفعة</button>
        <button class="btn btn-ghost" id="a-ret">↩️ بضاعة مرتجعة</button>
        <button class="btn btn-soft" id="a-inv">🧾 تسجيل المحدد كفاتورة</button>
        <button class="btn btn-due" id="a-del">🗑️ حذف المحدد</button>
      </div></div>

      <div class="card" style="margin-top:16px;">
        <div class="card-head"><h3>حركات وأصناف المحل</h3>
          <div style="display:flex; gap:8px;">
            ${['all:الكل','due:مستحق','invoiced:بفاتورة','return:مرتجع','payment:دفعات'].map((f)=>{const [k,l]=f.split(':');return `<span class="chip ${state.filter===k?'active':''}" data-f="${k}">${l}</span>`;}).join('')}
          </div>
        </div>
        <div class="card-body" style="padding:0 4px;"><table>
          <thead><tr><th style="width:36px"><span class="check" id="chk-all"></span></th><th>التاريخ</th><th>كود الصنف</th><th>البيان</th><th>الكمية</th><th>السعر</th><th>المبلغ</th><th>الدفع</th><th>الحالة</th></tr></thead>
          <tbody id="entries-body"></tbody></table><div id="entries-empty" class="empty hidden">لا توجد حركات في هذا التصنيف.</div></div>
      </div>

      <div class="card" style="margin-top:16px; max-width:460px;">
        <div class="card-head"><h3>الإجمالي مع ضريبة القيمة المضافة</h3></div>
        <div class="card-body" style="padding:8px 16px 12px;"><table>
          <tr><td>الإجمالي قبل الضريبة</td><td class="amount num" style="text-align:left">${money(vat.base)} ${cur()}</td></tr>
          <tr><td>ضريبة القيمة المضافة (${money(vat.rate)}%)</td><td class="amount num" style="text-align:left">${money(vat.vat)} ${cur()}</td></tr>
          <tr><td style="font-weight:800">الإجمالي المستحق شامل الضريبة</td><td class="amount due num" style="text-align:left;font-size:1.1rem">${money(vat.total)} ${cur()}</td></tr>
        </table></div>
      </div>`;

    renderEntries(d.entries);
    $('#back').addEventListener('click', () => navigate('shops'));
    $('#edit-shop').addEventListener('click', () => openShopModal(d, () => renderShop()));
    $('#print-statement').addEventListener('click', () => printStatement(d));
    $('#wa-remind').addEventListener('click', () => waSend(d.phone, `السلام عليكم، تذكير ودّي من ${SETTINGS.business_name}: الرصيد المستحق على حسابكم ${money(t.balance)} ${cur()}. نأمل ترتيب السداد، وشكراً.`));
    $('#a-item').addEventListener('click', () => openItemModal(d.id));
    $('#a-pay').addEventListener('click', () => openPaymentModal(d.id));
    $('#a-ret').addEventListener('click', () => openReturnModal(d.id));
    $('#a-inv').addEventListener('click', () => invoiceSelected());
    $('#a-del').addEventListener('click', () => deleteSelected());
    $$('.chip[data-f]').forEach((c) => c.addEventListener('click', () => { state.filter = c.dataset.f; state.selected = new Set(); renderShop(); }));
    $('#chk-all').addEventListener('click', () => {
      const rows = $$('#entries-body tr[data-id]');
      const all = state.selected.size === rows.length && rows.length > 0;
      state.selected = new Set(); if (!all) rows.forEach((r) => state.selected.add(Number(r.dataset.id)));
      renderShop();
    });
  }

  function renderEntries(entries) {
    const body = $('#entries-body');
    $('#entries-empty').classList.toggle('hidden', entries.length > 0);
    const methodBadge = { cash: '<span class="badge b-cash">نقدي</span>', card: '<span class="badge b-card">شبكة</span>', transfer: '<span class="badge b-transfer">تحويل</span>' };
    const statusOf = (e) => {
      if (e.kind === 'payment') return '<span class="badge b-paid">دفعة</span>';
      if (e.kind === 'return') return '<span class="badge b-ret">مرتجع</span>';
      if (e.status === 'invoiced') return `<span class="badge b-inv">🧾 ${esc(e.invoice_no)?('#'+esc(e.invoice_no)):'بفاتورة'}</span>`;
      return '<span class="badge b-due">مستحق</span>';
    };
    body.innerHTML = entries.map((e) => {
      const rowCls = e.kind === 'payment' ? 'paid-row' : e.status === 'invoiced' ? 'on-invoice' : '';
      const sel = state.selected.has(e.id) ? 'selected' : '';
      const desc = e.kind === 'payment' ? '💵 دفعة تسديد على الحساب' : e.kind === 'return' ? ('↩️ مرتجع: ' + esc(e.description || e.item_code || '')) : esc(e.description || '');
      const amtCls = e.kind === 'payment' ? 'paid' : e.kind === 'return' ? 'ret' : (e.status==='invoiced'?'':'due');
      const amtSign = e.kind === 'return' ? '-' : '';
      const selectable = e.kind === 'item';
      return `<tr class="${rowCls} ${sel}" data-id="${e.id}" data-kind="${e.kind}">
        <td>${selectable?`<span class="check ${sel?'on':''}" data-sel="${e.id}"></span>`:''}</td>
        <td class="num">${esc(e.date)}</td>
        <td class="code">${esc(e.item_code)||'—'}</td>
        <td class="desc">${desc||'—'}</td>
        <td class="num">${e.qty?money(e.qty):'—'}</td>
        <td class="num">${e.price?money(e.price):'—'}</td>
        <td class="amount ${amtCls} num">${amtSign}${money(e.amount)}</td>
        <td>${e.payment_method?methodBadge[e.payment_method]:'—'}</td>
        <td>${statusOf(e)}</td></tr>`;
    }).join('');
    $$('#entries-body .check[data-sel]').forEach((c) => c.addEventListener('click', (ev) => {
      ev.stopPropagation(); const id = Number(c.dataset.sel);
      if (state.selected.has(id)) state.selected.delete(id); else state.selected.add(id);
      c.classList.toggle('on'); c.closest('tr').classList.toggle('selected');
    }));
  }

  async function invoiceSelected() {
    const ids = [...state.selected]; if (!ids.length) return toast('حدّد أصنافاً أولاً', 'err');
    // احسب مجموع الأصناف المحددة + الضريبة وقت عمل الفاتورة
    const rows = $$('#entries-body tr[data-id]').filter((r) => state.selected.has(Number(r.dataset.id)));
    let subtotal = 0; rows.forEach((r) => { const c = r.children[6]; const val = Number((c?.textContent||'').replace(/[^\d.\-]/g,'')); if (Number.isFinite(val)) subtotal += val; });
    const rate = Number(SETTINGS.vat_rate || 0);
    const vat = Math.round(subtotal * rate) / 100 * 1; const vatAmt = +(subtotal * rate / 100).toFixed(2); const total = +(subtotal + vatAmt).toFixed(2);
    const m = modal(`
      <div class="modal-head"><h3>تسجيل فاتورة خارجية</h3><button class="modal-close" data-close>&times;</button></div>
      <p class="sub">سيتم إخراج ${ids.length} صنف كفاتورة وخصمها من دين المحل.</p>
      <label>رقم الفاتورة (اختياري)</label><input id="inv-no" placeholder="مثال: 1042" />
      <label style="margin-top:6px"><input type="checkbox" id="inv-vat" checked style="width:auto;margin:0 0 0 6px"> إضافة ضريبة القيمة المضافة (${money(rate)}%)</label>
      <div class="card" style="margin-top:10px"><div class="card-body" style="padding:12px 14px">
        <div class="stat-line"><span>المجموع قبل الضريبة</span><strong class="num">${money(subtotal)} ${cur()}</strong></div>
        <div class="stat-line" id="vat-line"><span>الضريبة (${money(rate)}%)</span><strong class="num">${money(vatAmt)} ${cur()}</strong></div>
        <div class="stat-line" style="border:none;font-weight:800"><span>الإجمالي بالفاتورة</span><strong class="num" id="inv-total">${money(total)} ${cur()}</strong></div>
      </div></div>
      <div class="modal-actions"><button type="button" class="btn btn-ghost" data-close>إلغاء</button><button class="btn btn-green btn-block" id="inv-confirm">تأكيد وإخراج الفاتورة</button></div>`);
    $('#inv-vat').addEventListener('change', (e) => {
      const withVat = e.target.checked; const tot = withVat ? total : subtotal;
      $('#vat-line').style.opacity = withVat ? '1' : '.4';
      $('#inv-total').textContent = money(tot) + ' ' + cur();
    });
    $('#inv-confirm').addEventListener('click', async () => {
      try { await api('/entries/invoice', { method: 'POST', body: { ids, invoice_no: $('#inv-no').value, with_vat: $('#inv-vat').checked, vat_amount: vatAmt } }); m.close(); state.selected = new Set(); toast('تم إخراج الفاتورة وخصمها من الإجمالي', 'ok'); renderShop(); }
      catch (e) { toast(e.message, 'err'); }
    });
  }
  async function deleteSelected() {
    const ids = [...state.selected]; if (!ids.length) return toast('حدّد أصنافاً أولاً', 'err');
    if (!confirm(`حذف ${ids.length} حركة؟ لا يمكن التراجع.`)) return;
    try { await api('/entries/delete', { method: 'POST', body: { ids } }); state.selected = new Set(); toast('تم الحذف', 'ok'); renderShop(); }
    catch (e) { toast(e.message, 'err'); }
  }

  // ===== النوافذ =====
  function modal(html) {
    const root = $('#modal-root');
    root.innerHTML = `<div class="modal"><div class="modal-card">${html}</div></div>`;
    const close = () => (root.innerHTML = '');
    root.querySelector('.modal').addEventListener('click', (e) => { if (e.target === root.querySelector('.modal')) close(); });
    $$('[data-close]', root).forEach((b) => b.addEventListener('click', close));
    return { root, close };
  }

  function openShopModal(shop, after) {
    const m = modal(`
      <div class="modal-head"><h3>${shop?'تعديل محل':'محل جديد'}</h3><button class="modal-close" data-close>&times;</button></div>
      <form id="shop-form">
        <label>اسم المحل *</label><input id="s-name" value="${esc(shop?.name)||''}" />
        <div class="row2"><div><label>الكود</label><input id="s-code" value="${esc(shop?.code)||''}" /></div><div><label>الهاتف (لواتساب)</label><input id="s-phone" value="${esc(shop?.phone)||''}" /></div></div>
        <label>الحد الائتماني (تنبيه عند تجاوزه) — 0 = بدون حد</label><input type="number" id="s-limit" step="0.01" value="${shop?.credit_limit||0}" />
        <label>ملاحظات</label><textarea id="s-note" rows="2">${esc(shop?.note)||''}</textarea>
        <div class="form-error" id="s-err"></div>
        <div class="modal-actions"><button type="button" class="btn btn-ghost" data-close>إلغاء</button><button class="btn btn-green btn-block" type="submit">حفظ</button></div>
      </form>`);
    $('#shop-form').addEventListener('submit', async (e) => {
      e.preventDefault();
      const body = { name: $('#s-name').value, code: $('#s-code').value, phone: $('#s-phone').value, note: $('#s-note').value, credit_limit: $('#s-limit').value };
      try {
        if (shop) await api('/shops/' + shop.id, { method: 'PUT', body });
        else await api('/shops', { method: 'POST', body });
        m.close(); toast('تم الحفظ', 'ok'); after ? after() : navigate('shops');
      } catch (err) { $('#s-err').textContent = err.message; }
    });
  }

  function openItemModal(shopId) {
    const m = modal(`
      <div class="modal-head"><h3>إضافة بضاعة (دين)</h3><button class="modal-close" data-close>&times;</button></div>
      <form id="it-form">
        <div class="row2"><div><label>كود الصنف</label><input id="i-code" /></div><div><label>التاريخ</label><input type="date" id="i-date" value="${today()}" /></div></div>
        <label>البيان</label><input id="i-desc" />
        <div class="row3"><div><label>الكمية</label><input type="number" id="i-qty" step="0.01" value="1" /></div><div><label>السعر</label><input type="number" id="i-price" step="0.01" /></div><div><label>المبلغ</label><input id="i-amt" disabled /></div></div>
        <div class="form-error" id="i-err"></div>
        <div class="modal-actions"><button type="button" class="btn btn-ghost" data-close>إلغاء</button><button class="btn btn-green btn-block" type="submit">حفظ</button></div>
      </form>`);
    const calc = () => { $('#i-amt').value = money((Number($('#i-qty').value)||0) * (Number($('#i-price').value)||0)); };
    $('#i-qty').addEventListener('input', calc); $('#i-price').addEventListener('input', calc); calc();
    $('#it-form').addEventListener('submit', async (e) => {
      e.preventDefault();
      try { await api('/shops/' + shopId + '/items', { method: 'POST', body: { item_code: $('#i-code').value, description: $('#i-desc').value, qty: $('#i-qty').value, price: $('#i-price').value, date: $('#i-date').value } }); m.close(); toast('تمت إضافة البضاعة', 'ok'); renderShop(); }
      catch (err) { $('#i-err').textContent = err.message; }
    });
  }

  function openPaymentModal(shopId) {
    const m = modal(`
      <div class="modal-head"><h3>تسجيل دفعة</h3><button class="modal-close" data-close>&times;</button></div>
      <form id="pay-form">
        <div class="row2"><div><label>المبلغ *</label><input type="number" id="p-amt" step="0.01" /></div><div><label>التاريخ</label><input type="date" id="p-date" value="${today()}" /></div></div>
        <label>طريقة الدفع</label>
        <div class="seg" id="p-method" style="margin-bottom:14px;"><span class="active" data-m="cash">نقدي</span><span data-m="card">شبكة</span><span data-m="transfer">تحويل</span></div>
        <label>ملاحظة</label><input id="p-note" />
        <div class="form-error" id="p-err"></div>
        <div class="modal-actions"><button type="button" class="btn btn-ghost" data-close>إلغاء</button><button class="btn btn-green btn-block" type="submit">حفظ الدفعة</button></div>
      </form>`);
    let method = 'cash';
    $$('#p-method span').forEach((s) => s.addEventListener('click', () => { $$('#p-method span').forEach((x)=>x.classList.remove('active')); s.classList.add('active'); method = s.dataset.m; }));
    $('#pay-form').addEventListener('submit', async (e) => {
      e.preventDefault();
      try { await api('/shops/' + shopId + '/payments', { method: 'POST', body: { amount: $('#p-amt').value, payment_method: method, date: $('#p-date').value, note: $('#p-note').value } }); m.close(); toast('تم تسجيل الدفعة', 'ok'); renderShop(); }
      catch (err) { $('#p-err').textContent = err.message; }
    });
  }

  function openReturnModal(shopId) {
    const m = modal(`
      <div class="modal-head"><h3>بضاعة مرتجعة</h3><button class="modal-close" data-close>&times;</button></div>
      <form id="ret-form">
        <div class="row2"><div><label>كود الصنف</label><input id="r-code" /></div><div><label>التاريخ</label><input type="date" id="r-date" value="${today()}" /></div></div>
        <label>البيان</label><input id="r-desc" />
        <div class="row3"><div><label>الكمية</label><input type="number" id="r-qty" step="0.01" /></div><div><label>السعر</label><input type="number" id="r-price" step="0.01" /></div><div><label>القيمة</label><input type="number" id="r-amt" step="0.01" /></div></div>
        <div class="form-error" id="r-err"></div>
        <div class="modal-actions"><button type="button" class="btn btn-ghost" data-close>إلغاء</button><button class="btn btn-green btn-block" type="submit">حفظ المرتجع</button></div>
      </form>`);
    const calc = () => { const a = (Number($('#r-qty').value)||0)*(Number($('#r-price').value)||0); if (a) $('#r-amt').value = a.toFixed(2); };
    $('#r-qty').addEventListener('input', calc); $('#r-price').addEventListener('input', calc);
    $('#ret-form').addEventListener('submit', async (e) => {
      e.preventDefault();
      try { await api('/shops/' + shopId + '/returns', { method: 'POST', body: { item_code: $('#r-code').value, description: $('#r-desc').value, qty: $('#r-qty').value, price: $('#r-price').value, amount: $('#r-amt').value, date: $('#r-date').value } }); m.close(); toast('تم تسجيل المرتجع', 'ok'); renderShop(); }
      catch (err) { $('#r-err').textContent = err.message; }
    });
  }

  // ===== التقارير =====
  async function renderReports() {
    const month = new Date().toISOString().slice(0, 7);
    const v = $('#view');
    v.innerHTML = `
      <div class="topbar" style="margin:-24px -26px 22px; position:static;">
        <div class="page-title">التقارير<small>تقرير شهري قابل للحفظ PDF وإرساله بواتساب</small></div>
        <div class="topbar-actions no-print"><input type="month" id="rep-month" value="${month}" style="margin:0;width:auto" /><button class="btn btn-ghost" id="rep-wa">📲 إرسال واتساب</button><button class="btn btn-green" id="rep-print">🖨️ حفظ PDF / طباعة</button></div>
      </div>
      <div id="rep-body"></div>`;
    let last = null;
    const load = async () => {
      const r = await api('/reports/monthly?month=' + $('#rep-month').value);
      SETTINGS = r.settings || SETTINGS; last = r;
      $('#rep-body').innerHTML = reportDoc(r);
    };
    $('#rep-month').addEventListener('change', load);
    $('#rep-print').addEventListener('click', () => window.print());
    $('#rep-wa').addEventListener('click', () => {
      if (!last) return;
      const txt = `تقرير ${SETTINGS.business_name} — شهر ${last.month}\n`+
        `• المُسدّد: ${money(last.paid)} ${cur()} (نقدي ${money(last.cash)} / شبكة ${money(last.card)} / تحويل ${money(last.transfer)})\n`+
        `• ديون جديدة: ${money(last.newDebts)} ${cur()}\n`+
        `• مرتجعات: ${money(last.returns)} ${cur()}\n`+
        `• ضريبة (${money(last.vat.rate)}%): ${money(last.vat.vat)} ${cur()}\n`+
        `• صافي الديون المستحقة: ${money(last.totalDebt)} ${cur()}\n`+
        `أعلى المحلات: ${last.topShops.map((s)=>esc(s.name)+' '+money(s.balance)).join(' | ')}`;
      waSend('', txt);
    });
    load();
  }

  function reportDoc(r) {
    return `<div class="report-doc">
      <div class="rh"><img src="/assets/logo.png" alt="Lucky Sky" /><div style="text-align:left"><div style="font-weight:800">تقرير شهر ${esc(r.month)}</div><div class="sub">صادر: ${new Date().toISOString().slice(0,10)}</div></div></div>
      <div class="stat-line"><span>إجمالي المُسدّد خلال الشهر</span><strong class="col-paid" style="color:var(--green-3)">${money(r.paid)} ${cur()}</strong></div>
      <div class="stat-line"><span>&nbsp;&nbsp;• نقدي</span><strong>${money(r.cash)} ${cur()}</strong></div>
      <div class="stat-line"><span>&nbsp;&nbsp;• شبكة</span><strong>${money(r.card)} ${cur()}</strong></div>
      <div class="stat-line"><span>&nbsp;&nbsp;• تحويل</span><strong>${money(r.transfer)} ${cur()}</strong></div>
      <div class="stat-line"><span>ديون جديدة (بضاعة/سلف)</span><strong class="amount due">${money(r.newDebts)} ${cur()}</strong></div>
      <div class="stat-line"><span>بضاعة مرتجعة</span><strong>${money(r.returns)} ${cur()}</strong></div>
      <div class="stat-line"><span>ضريبة القيمة المضافة (${money(r.vat.rate)}%)</span><strong>${money(r.vat.vat)} ${cur()}</strong></div>
      <div class="stat-line" style="border-bottom:none;font-weight:800;font-size:1.05rem"><span>صافي الرصيد المستحق حالياً</span><strong class="amount due">${money(r.totalDebt)} ${cur()}</strong></div>
      <div style="margin-top:14px"><div style="font-weight:800;margin-bottom:6px">أعلى المحلات ديناً</div>
        ${r.topShops.map((s,i)=>`<div class="stat-line"><span>${i+1}. ${esc(s.name)}</span><strong class="amount due">${money(s.balance)} ${cur()}</strong></div>`).join('')||'<div class="sub">لا يوجد</div>'}
      </div>
      <div class="center sub" style="margin-top:16px">${esc(SETTINGS.business_name)} • تقرير داخلي</div>
    </div>`;
  }

  function printStatement(d) {
    const w = window.open('', '_blank');
    const rows = d.entries.map((e) => `<tr><td>${esc(e.date)}</td><td>${esc(e.item_code)||''}</td><td>${esc(e.description||({payment:'دفعة',return:'مرتجع'}[e.kind])||'')}</td><td>${e.qty||''}</td><td>${e.price||''}</td><td>${money(e.amount)}</td><td>${({item:'دين',payment:'دفعة',return:'مرتجع'}[e.kind])}${e.status==='invoiced'?' (فاتورة)':''}</td></tr>`).join('');
    w.document.write(`<html dir="rtl"><head><meta charset="utf-8"><title>كشف حساب ${esc(d.name)}</title>
      <style>body{font-family:Cairo,Arial,sans-serif;padding:24px}h2{color:#4a942f}table{width:100%;border-collapse:collapse;margin-top:12px}th,td{border:1px solid #ddd;padding:8px;text-align:right;font-size:13px}th{background:#f1f8ec}.tot{font-size:18px;font-weight:800;color:#d94b3d;margin-top:14px}</style></head>
      <body><h2>كشف حساب: ${esc(d.name)}</h2><div>الهاتف: ${esc(d.phone)||'—'} • التاريخ: ${new Date().toISOString().slice(0,10)}</div>
      <table><thead><tr><th>التاريخ</th><th>الكود</th><th>البيان</th><th>الكمية</th><th>السعر</th><th>المبلغ</th><th>النوع</th></tr></thead><tbody>${rows}</tbody></table>
      <div class="tot">الرصيد المستحق: ${money(d.totals.balance)} ${cur()}</div>
      <script>window.onload=()=>window.print()<\/script></body></html>`);
    w.document.close();
  }

  // ===== استيراد إكسل =====
  function renderImport() {
    const v = $('#view');
    v.innerHTML = `
      <div class="topbar" style="margin:-24px -26px 22px; position:static;"><div class="page-title">استيراد من إكسل<small>ارفع ملفك وسيقرأ البرنامج بياناتك ويدخلها</small></div></div>
      <div class="card" style="max-width:720px"><div class="card-body" style="padding:18px">
        <div class="drop" id="drop"><div class="big">📊</div><div class="t">اضغط لاختيار ملف إكسل</div><div>يدعم .xlsx و .xls و .csv — أكثر من 20,000 صف</div><input type="file" id="file" accept=".xlsx,.xls,.csv" class="hidden" /></div>
        <div id="import-config" class="hidden" style="margin-top:16px"></div>
      </div></div>`;
    $('#drop').addEventListener('click', () => $('#file').click());
    $('#file').addEventListener('change', onFile);
  }

  let importFile = null, importHeaders = [];
  async function onFile(e) {
    const f = e.target.files[0]; if (!f) return; importFile = f;
    const fd = new FormData(); fd.append('file', f);
    toast('جارٍ قراءة الملف…');
    try {
      const r = await api('/import/preview', { method: 'POST', body: fd });
      importHeaders = r.headers;
      const opts = (sel) => '<option value="">—</option>' + r.headers.map((h,i)=>`<option value="${i}::${esc(h)}" ${sel&&sel.test(h)?'selected':''}>${esc(h)}</option>`).join('');
      // ملاحظة: نمرر اسم العمود للسيرفر عبر sheet_to_json الذي يستخدم رؤوس الأعمدة كمفاتيح
      const optByName = (re) => '<option value="">—</option>' + r.headers.map((h)=>`<option value="${esc(h)}" ${re&&re.test(h)?'selected':''}>${esc(h)}</option>`).join('');
      $('#import-config').classList.remove('hidden');
      $('#import-config').innerHTML = `
        <div style="font-weight:800;margin-bottom:8px">✔️ تم قراءة الملف: <span style="color:var(--green-3)">${esc(f.name)} (${money(r.totalRows)} صف)</span></div>
        <div class="sub" style="margin-bottom:10px">طابِق الأعمدة (تلقائي، عدّل عند الحاجة):</div>
        <div class="map-row"><label>عمود المحل</label><select id="m-shop">${optByName(/محل|shop|store|اسم/i)}</select></div>
        <div class="map-row"><label>التاريخ</label><select id="m-date">${optByName(/date|تاريخ/i)}</select></div>
        <div class="map-row"><label>كود الصنف</label><select id="m-code">${optByName(/code|كود|item/i)}</select></div>
        <div class="map-row"><label>البيان</label><select id="m-desc">${optByName(/desc|بيان|وصف/i)}</select></div>
        <div class="map-row"><label>الكمية</label><select id="m-qty">${optByName(/qty|كمي/i)}</select></div>
        <div class="map-row"><label>السعر</label><select id="m-price">${optByName(/price|سعر/i)}</select></div>
        <div class="map-row"><label>المبلغ/الدين</label><select id="m-amount">${optByName(/religion|دين|amount|مبلغ|total/i)}</select></div>
        <div class="map-row"><label>مسدّد (اختياري)</label><select id="m-payment">${optByName(/payment|مسدد|دفع|paid/i)}</select></div>
        <div class="map-row" id="shop-name-row"><label>اسم محل موحّد</label><input id="m-shopname" placeholder="اسم محل واحد لكل الصفوف إن لم يوجد عمود للمحل" style="margin:0" /></div>
        <button class="btn btn-green btn-block" id="do-import" style="margin-top:14px">استيراد ${money(r.totalRows)} صف الآن</button>
        <div class="form-error" id="imp-err" style="margin-top:8px"></div>`;
      $('#do-import').addEventListener('click', doImport);
    } catch (err) { toast(err.message, 'err'); }
  }

  async function doImport() {
    const mapping = { shop: val('m-shop'), date: val('m-date'), item_code: val('m-code'), description: val('m-desc'), qty: val('m-qty'), price: val('m-price'), amount: val('m-amount'), payment: val('m-payment') };
    const fd = new FormData(); fd.append('file', importFile); fd.append('mapping', JSON.stringify(mapping)); fd.append('shop_name', $('#m-shopname').value || '');
    $('#do-import').disabled = true; $('#do-import').textContent = 'جارٍ الاستيراد…';
    try {
      const r = await api('/import/commit', { method: 'POST', body: fd });
      toast(`تم استيراد ${r.imported} صنف و ${r.payments} دفعة`, 'ok');
      navigate('dashboard');
    } catch (err) { $('#imp-err').textContent = err.message; $('#do-import').disabled = false; $('#do-import').textContent = 'إعادة المحاولة'; }
    function val(id){ return $('#'+id).value; }
  }
  function val(id){ return $('#'+id).value; }

  // ===== النسخ الاحتياطي =====
  async function renderBackups() {
    const v = $('#view');
    const list = await api('/backups');
    v.innerHTML = `
      <div class="topbar" style="margin:-24px -26px 22px; position:static;"><div class="page-title">النسخ الاحتياطي<small>حماية بياناتك مدى الحياة</small></div>
        <div class="topbar-actions"><button class="btn btn-ghost" id="export-json">⬇️ تصدير كامل JSON</button><button class="btn btn-green" id="mk-backup">＋ نسخة احتياطية الآن</button></div></div>
      <div class="card"><div class="card-body" style="padding:16px">
        <div class="sub" style="margin-bottom:10px">تُنشأ نسخة تلقائية يومياً وتُحفظ على الخادم. يمكنك أيضاً إنشاء نسخة يدوية أو تصدير كل البيانات.</div>
        <table><thead><tr><th>الملف</th><th>الحجم</th><th>التاريخ</th><th></th></tr></thead><tbody id="bk-body"></tbody></table>
        <div id="bk-empty" class="empty ${list.length?'hidden':''}">لا نسخ بعد.</div>
      </div></div>`;
    $('#bk-body').innerHTML = list.map((b)=>`<tr><td>${esc(b.file)}</td><td>${(b.size/1024).toFixed(0)} KB</td><td>${esc(b.created.slice(0,19).replace('T',' '))}</td><td><a class="back-link" href="/api/backups/download?file=${encodeURIComponent(b.file)}">تنزيل</a></td></tr>`).join('');
    $('#mk-backup').addEventListener('click', async () => { await api('/backups', { method:'POST' }); toast('تم إنشاء نسخة احتياطية', 'ok'); renderBackups(); });
    $('#export-json').addEventListener('click', () => window.location.href = '/api/export');
  }

  // ===== سجل العمليات =====
  async function renderAudit() {
    const rows = await api('/audit');
    const v = $('#view');
    v.innerHTML = `
      <div class="topbar" style="margin:-24px -26px 22px; position:static;"><div class="page-title">سجل العمليات<small>كل إضافة/تعديل/حذف مسجّلة (للمراجعة والمساءلة)</small></div></div>
      <div class="card"><div class="card-body" style="padding:0 4px"><table>
        <thead><tr><th>الوقت</th><th>العملية</th><th>الجهة</th><th>التفاصيل</th></tr></thead>
        <tbody>${rows.map((r)=>`<tr><td class="num">${esc(r.at)}</td><td><span class="badge b-inv">${esc(r.action)}</span></td><td class="code">${esc(r.entity)}</td><td class="sub">${esc(r.details)}</td></tr>`).join('')}</tbody>
      </table>${rows.length?'':'<div class="empty">لا عمليات بعد.</div>'}</div></div>`;
  }

  // ===== الإعدادات =====
  async function renderSettings() {
    const s = await api('/settings'); SETTINGS = s;
    const v = $('#view');
    v.innerHTML = `
      <div class="topbar" style="margin:-24px -26px 22px; position:static;"><div class="page-title">الإعدادات والضريبة</div></div>
      <div class="card" style="max-width:520px"><div class="card-body" style="padding:18px">
        <form id="set-form">
          <label>اسم النشاط</label><input id="set-name" value="${esc(s.business_name)}" />
          <div class="row2"><div><label>العملة</label><input id="set-cur" value="${esc(s.currency)}" /></div><div><label>نسبة الضريبة (%)</label><input type="number" id="set-vat" step="0.01" value="${esc(s.vat_rate)}" /></div></div>
          <div class="form-error" id="set-err"></div>
          <button class="btn btn-green btn-block" type="submit">حفظ الإعدادات</button>
        </form>
        <div class="sub" style="margin-top:14px">لتغيير كلمة المرور: تُضبط على الخادم عبر المتغيّر <code>LUCKY_SKY_PASSWORD</code>.</div>
      </div></div>`;
    $('#set-form').addEventListener('submit', async (e) => {
      e.preventDefault();
      try { SETTINGS = await api('/settings', { method:'PUT', body: { business_name: $('#set-name').value, currency: $('#set-cur').value, vat_rate: $('#set-vat').value } }); toast('تم حفظ الإعدادات', 'ok'); }
      catch (err) { $('#set-err').textContent = err.message; }
    });
  }

  function today() { return new Date().toISOString().slice(0, 10); }

  // فتح واتساب برسالة جاهزة (يعمل من الجوال والويب)
  function waSend(phone, text) {
    let p = String(phone || '').replace(/[^\d]/g, '');
    if (p && p.startsWith('0')) p = '966' + p.slice(1); // تحويل الأرقام السعودية المحلية
    const url = 'https://wa.me/' + (p || '') + '?text=' + encodeURIComponent(text);
    window.open(url, '_blank');
  }

  // رسم بياني بسيط (SVG) لآخر 6 أشهر: ديون مقابل مُسدّد
  function miniChart(series) {
    const w = 460, h = 150, pad = 24, n = series.length || 1;
    const max = Math.max(1, ...series.map((s) => Math.max(s.debts, s.paid)));
    const bw = (w - pad * 2) / n / 2.6;
    let bars = '';
    series.forEach((s, i) => {
      const x = pad + (i + 0.5) * ((w - pad * 2) / n);
      const hd = (s.debts / max) * (h - pad * 2), hp = (s.paid / max) * (h - pad * 2);
      bars += `<rect x="${x - bw - 2}" y="${h - pad - hd}" width="${bw}" height="${hd}" rx="3" fill="var(--due)"></rect>`;
      bars += `<rect x="${x + 2}" y="${h - pad - hp}" width="${bw}" height="${hp}" rx="3" fill="var(--green)"></rect>`;
      bars += `<text x="${x}" y="${h - 7}" text-anchor="middle" font-size="10" fill="var(--muted)">${esc(s.month.slice(5))}</text>`;
    });
    return `<svg viewBox="0 0 ${w} ${h}" style="width:100%;height:${h}px">${bars}</svg>
      <div style="display:flex;gap:16px;justify-content:center;font-size:.8rem;color:var(--muted)"><span>🟥 ديون جديدة</span><span>🟩 مُسدّد</span></div>`;
  }

  // ===== بدء التشغيل =====
  (async function init() {
    try { const d = await api('/dashboard'); SETTINGS = d.settings || SETTINGS; showApp(); const r = routeFromHash(); navigate(r.route, r.shopId ? { shopId: r.shopId } : {}); }
    catch (_) { showLogin(); }
  })();
})();

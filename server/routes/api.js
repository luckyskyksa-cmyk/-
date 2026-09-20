const express = require('express');
const multer = require('multer');
const XLSX = require('xlsx');
const path = require('path');
const fs = require('fs');
const { db, DATA_DIR, dbPath, getSettings } = require('../db');
const { requireAuth } = require('../auth');
const { shopTotals, vatBreakdown, round2, shopAging } = require('../model');
const { createBackup, listBackups, BACKUP_DIR } = require('../backup');
const audit = require('../audit');

const router = express.Router();
const upload = multer({ dest: path.join(DATA_DIR, 'tmp'), limits: { fileSize: 50 * 1024 * 1024 } });

router.use(requireAuth);

// ============ الإعدادات ============
router.get('/settings', (req, res) => res.json(getSettings()));
router.put('/settings', (req, res) => {
  const allowed = ['currency', 'vat_rate', 'business_name'];
  const stmt = db.prepare('INSERT INTO settings (key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value');
  for (const k of allowed) if (k in (req.body || {})) stmt.run(k, String(req.body[k]));
  res.json(getSettings());
});

// ============ لوحة التحكم ============
router.get('/dashboard', (req, res) => {
  const shops = db.prepare('SELECT id, name, code, phone FROM shops').all();
  let totalDebt = 0;
  const ranked = shops.map((s) => {
    const t = shopTotals(s.id);
    totalDebt += t.balance;
    const last = db.prepare('SELECT MAX(date) AS d, COUNT(*) AS c FROM entries WHERE shop_id=?').get(s.id);
    return { ...s, balance: t.balance, lastDate: last.d, entriesCount: last.c };
  });
  ranked.sort((a, b) => b.balance - a.balance);

  const month = (req.query.month || new Date().toISOString().slice(0, 7));
  const monthStats = db
    .prepare(
      `SELECT
        COALESCE(SUM(CASE WHEN kind='payment' THEN amount ELSE 0 END),0) AS paid,
        COALESCE(SUM(CASE WHEN kind='item' THEN amount ELSE 0 END),0) AS newDebts,
        COALESCE(SUM(CASE WHEN kind='return' THEN amount ELSE 0 END),0) AS returns
      FROM entries WHERE substr(date,1,7)=?`
    )
    .get(month);

  const recent = db
    .prepare(
      `SELECT e.*, s.name AS shop_name FROM entries e
       JOIN shops s ON s.id=e.shop_id
       ORDER BY e.id DESC LIMIT 8`
    )
    .all();

  // تنبيهات: محلات تجاوزت الحد الائتماني أو ديون قديمة (متأخرة في السداد)
  const shopsFull = db.prepare('SELECT id, name, phone, credit_limit FROM shops').all();
  const alerts = [];
  for (const s of shopsFull) {
    const bal = shopTotals(s.id).balance;
    if (bal <= 0.001) continue;
    const aging = shopAging(s.id);
    const overLimit = s.credit_limit > 0 && bal > s.credit_limit;
    const overdue = aging.days > 60;
    if (overLimit || overdue) alerts.push({ id: s.id, name: s.name, phone: s.phone, balance: round2(bal), creditLimit: s.credit_limit, days: aging.days, overLimit, overdue });
  }
  alerts.sort((a, b) => b.balance - a.balance);

  // سلسلة آخر 6 أشهر (ديون جديدة مقابل المُسدّد) للرسم البياني
  const series = [];
  for (let i = 5; i >= 0; i--) {
    const dt = new Date(); dt.setMonth(dt.getMonth() - i);
    const m = dt.toISOString().slice(0, 7);
    const r = db.prepare(`SELECT COALESCE(SUM(CASE WHEN kind='item' THEN amount ELSE 0 END),0) AS d, COALESCE(SUM(CASE WHEN kind='payment' THEN amount ELSE 0 END),0) AS p FROM entries WHERE substr(date,1,7)=?`).get(m);
    series.push({ month: m, debts: round2(r.d), paid: round2(r.p) });
  }

  // أصناف قاربت على النفاد
  const lowStock = db.prepare('SELECT id, name, code, stock, unit, low_threshold FROM products WHERE stock <= low_threshold ORDER BY stock ASC LIMIT 8').all();
  const productsCount = db.prepare('SELECT COUNT(*) AS c FROM products').get().c;
  const monthSales = db.prepare(`SELECT COALESCE(SUM(total),0) AS t FROM sales WHERE substr(date,1,7)=?`).get(month).t;
  const monthPurch = db.prepare(`SELECT COALESCE(SUM(total),0) AS t FROM purchases WHERE substr(date,1,7)=?`).get(month).t;

  res.json({
    totalDebt: round2(totalDebt),
    shopsCount: shops.length,
    debtorsCount: ranked.filter((s) => s.balance > 0.001).length,
    month,
    monthPaid: round2(monthStats.paid),
    monthNewDebts: round2(monthStats.newDebts),
    monthReturns: round2(monthStats.returns),
    monthSales: round2(monthSales),
    monthPurchases: round2(monthPurch),
    productsCount,
    lowStock,
    topShops: ranked.slice(0, 8),
    recent,
    alerts: alerts.slice(0, 6),
    series,
    settings: getSettings(),
  });
});

// سجل العمليات
router.get('/audit', (req, res) => res.json(audit.recent(300)));

// ============ المحلات ============
router.get('/shops', (req, res) => {
  const search = (req.query.search || '').trim();
  let shops;
  if (search) {
    const like = `%${search}%`;
    shops = db.prepare('SELECT * FROM shops WHERE name LIKE ? OR phone LIKE ? OR code LIKE ? ORDER BY name').all(like, like, like);
  } else {
    shops = db.prepare('SELECT * FROM shops ORDER BY name').all();
  }
  const out = shops.map((s) => ({ ...s, balance: shopTotals(s.id).balance }));
  out.sort((a, b) => b.balance - a.balance);
  res.json(out);
});

router.post('/shops', (req, res) => {
  const { name, code, phone, note, credit_limit } = req.body || {};
  if (!name || !name.trim()) return res.status(400).json({ error: 'اسم المحل مطلوب' });
  const info = db.prepare('INSERT INTO shops (name, code, phone, note, credit_limit) VALUES (?,?,?,?,?)').run(name.trim(), (code || '').trim(), (phone || '').trim(), (note || '').trim(), Number(credit_limit) || 0);
  audit.log('إضافة محل', 'shop', { id: info.lastInsertRowid, name: name.trim() });
  res.status(201).json({ id: info.lastInsertRowid });
});

router.put('/shops/:id', (req, res) => {
  const s = db.prepare('SELECT * FROM shops WHERE id=?').get(req.params.id);
  if (!s) return res.status(404).json({ error: 'المحل غير موجود' });
  const { name, code, phone, note, credit_limit } = req.body || {};
  if (!name || !name.trim()) return res.status(400).json({ error: 'اسم المحل مطلوب' });
  db.prepare('UPDATE shops SET name=?, code=?, phone=?, note=?, credit_limit=? WHERE id=?').run(name.trim(), (code || '').trim(), (phone || '').trim(), (note || '').trim(), Number(credit_limit) || 0, req.params.id);
  audit.log('تعديل محل', 'shop', { id: req.params.id, name: name.trim() });
  res.json({ ok: true });
});

router.delete('/shops/:id', (req, res) => {
  const s = db.prepare('SELECT name FROM shops WHERE id=?').get(req.params.id);
  db.prepare('DELETE FROM shops WHERE id=?').run(req.params.id);
  audit.log('حذف محل', 'shop', { id: req.params.id, name: s && s.name });
  res.json({ ok: true });
});

router.get('/shops/:id', (req, res) => {
  const shop = db.prepare('SELECT * FROM shops WHERE id=?').get(req.params.id);
  if (!shop) return res.status(404).json({ error: 'المحل غير موجود' });
  const filter = req.query.filter || 'all';
  let where = 'shop_id=?';
  const params = [req.params.id];
  if (filter === 'due') where += " AND kind='item' AND status='due'";
  else if (filter === 'invoiced') where += " AND kind='item' AND status='invoiced'";
  else if (filter === 'return') where += " AND kind='return'";
  else if (filter === 'payment') where += " AND kind='payment'";
  const entries = db.prepare(`SELECT * FROM entries WHERE ${where} ORDER BY date DESC, id DESC`).all(...params);
  const totals = shopTotals(shop.id);
  const vat = vatBreakdown(totals.balance);
  const aging = shopAging(shop.id);
  const overLimit = shop.credit_limit > 0 && totals.balance > shop.credit_limit;
  res.json({ ...shop, totals, vat, aging, overLimit, entries, settings: getSettings() });
});

// ============ الحركات ============
router.post('/shops/:id/items', (req, res) => {
  const shop = db.prepare('SELECT id FROM shops WHERE id=?').get(req.params.id);
  if (!shop) return res.status(404).json({ error: 'المحل غير موجود' });
  const { item_code, description, qty, price, date, note } = req.body || {};
  const q = Number(qty), p = Number(price);
  if (!Number.isFinite(q) || !Number.isFinite(p)) return res.status(400).json({ error: 'الكمية والسعر مطلوبان' });
  const amount = round2(q * p);
  const d = (date && String(date).trim()) || new Date().toISOString().slice(0, 10);
  db.prepare(`INSERT INTO entries (shop_id, kind, date, item_code, description, qty, price, amount, status, note) VALUES (?,?,?,?,?,?,?,?, 'due', ?)`)
    .run(req.params.id, 'item', d, (item_code || '').trim(), (description || '').trim(), q, p, amount, (note || '').trim());
  audit.log('إضافة بضاعة (دين)', 'shop:' + req.params.id, { desc: (description || '').trim(), amount });
  res.status(201).json({ ok: true, balance: shopTotals(req.params.id).balance });
});

router.post('/shops/:id/payments', (req, res) => {
  const shop = db.prepare('SELECT id FROM shops WHERE id=?').get(req.params.id);
  if (!shop) return res.status(404).json({ error: 'المحل غير موجود' });
  const { amount, payment_method, date, note } = req.body || {};
  const a = Number(amount);
  if (!Number.isFinite(a) || a <= 0) return res.status(400).json({ error: 'المبلغ يجب أن يكون أكبر من صفر' });
  const method = ['cash', 'card', 'transfer'].includes(payment_method) ? payment_method : 'cash';
  const d = (date && String(date).trim()) || new Date().toISOString().slice(0, 10);
  db.prepare(`INSERT INTO entries (shop_id, kind, date, amount, payment_method, note) VALUES (?,?,?,?,?,?)`)
    .run(req.params.id, 'payment', d, round2(a), method, (note || '').trim());
  audit.log('تسجيل دفعة', 'shop:' + req.params.id, { amount: round2(a), method });
  res.status(201).json({ ok: true, balance: shopTotals(req.params.id).balance });
});

router.post('/shops/:id/returns', (req, res) => {
  const shop = db.prepare('SELECT id FROM shops WHERE id=?').get(req.params.id);
  if (!shop) return res.status(404).json({ error: 'المحل غير موجود' });
  const { item_code, description, qty, price, amount, date, note } = req.body || {};
  let amt = Number(amount);
  const q = Number(qty), p = Number(price);
  if (!Number.isFinite(amt) || amt <= 0) {
    if (Number.isFinite(q) && Number.isFinite(p)) amt = round2(q * p);
    else return res.status(400).json({ error: 'قيمة المرتجع مطلوبة' });
  }
  const d = (date && String(date).trim()) || new Date().toISOString().slice(0, 10);
  db.prepare(`INSERT INTO entries (shop_id, kind, date, item_code, description, qty, price, amount, note) VALUES (?,?,?,?,?,?,?,?,?)`)
    .run(req.params.id, 'return', d, (item_code || '').trim(), (description || '').trim(), q || 0, p || 0, round2(amt), (note || '').trim());
  audit.log('بضاعة مرتجعة', 'shop:' + req.params.id, { desc: (description || '').trim(), amount: round2(amt) });
  res.status(201).json({ ok: true, balance: shopTotals(req.params.id).balance });
});

// تسجيل أصناف محددة كفاتورة خارجية (تُخصم من الإجمالي وتتلوّن)
router.post('/entries/invoice', (req, res) => {
  const { ids, invoice_no, with_vat, vat_amount } = req.body || {};
  if (!Array.isArray(ids) || !ids.length) return res.status(400).json({ error: 'لم يتم تحديد أصناف' });
  const inv = (invoice_no || '').trim();
  const stmt = db.prepare("UPDATE entries SET status='invoiced', invoice_no=? WHERE id=? AND kind='item'");
  const tx = db.transaction((list) => { for (const id of list) stmt.run(inv, id); });
  tx(ids.map(Number));
  audit.log('تسجيل فاتورة خارجية', 'entries', { count: ids.length, invoice_no: inv, vat: with_vat ? round2(vat_amount) : 0 });
  res.json({ ok: true });
});

// إلغاء تسجيل الفاتورة (إرجاع الصنف مستحقاً)
router.post('/entries/uninvoice', (req, res) => {
  const { ids } = req.body || {};
  if (!Array.isArray(ids) || !ids.length) return res.status(400).json({ error: 'لم يتم تحديد أصناف' });
  const stmt = db.prepare("UPDATE entries SET status='due', invoice_no='' WHERE id=? AND kind='item'");
  const tx = db.transaction((list) => { for (const id of list) stmt.run(id); });
  tx(ids.map(Number));
  res.json({ ok: true });
});

router.post('/entries/delete', (req, res) => {
  const { ids } = req.body || {};
  if (!Array.isArray(ids) || !ids.length) return res.status(400).json({ error: 'لم يتم تحديد حركات' });
  const stmt = db.prepare('DELETE FROM entries WHERE id=?');
  const tx = db.transaction((list) => { for (const id of list) stmt.run(id); });
  tx(ids.map(Number));
  audit.log('حذف حركات', 'entries', { ids });
  res.json({ ok: true });
});

// ============ التقرير الشهري ============
router.get('/reports/monthly', (req, res) => {
  const month = req.query.month || new Date().toISOString().slice(0, 7);
  const stats = db
    .prepare(
      `SELECT
        COALESCE(SUM(CASE WHEN kind='payment' THEN amount ELSE 0 END),0) AS paid,
        COALESCE(SUM(CASE WHEN kind='payment' AND payment_method='cash' THEN amount ELSE 0 END),0) AS cash,
        COALESCE(SUM(CASE WHEN kind='payment' AND payment_method='card' THEN amount ELSE 0 END),0) AS card,
        COALESCE(SUM(CASE WHEN kind='payment' AND payment_method='transfer' THEN amount ELSE 0 END),0) AS transfer,
        COALESCE(SUM(CASE WHEN kind='item' THEN amount ELSE 0 END),0) AS newDebts,
        COALESCE(SUM(CASE WHEN kind='return' THEN amount ELSE 0 END),0) AS returns
      FROM entries WHERE substr(date,1,7)=?`
    )
    .get(month);

  const shops = db.prepare('SELECT id, name FROM shops').all();
  let totalDebt = 0;
  const ranked = shops.map((s) => { const b = shopTotals(s.id).balance; totalDebt += b; return { name: s.name, balance: round2(b) }; });
  ranked.sort((a, b) => b.balance - a.balance);

  const vat = vatBreakdown(totalDebt);
  const salesStats = db.prepare(`SELECT COALESCE(SUM(total),0) AS total, COALESCE(SUM(vat),0) AS vat, COUNT(*) AS cnt FROM sales WHERE substr(date,1,7)=?`).get(month);
  const purchStats = db.prepare(`SELECT COALESCE(SUM(total),0) AS total, COUNT(*) AS cnt FROM purchases WHERE substr(date,1,7)=?`).get(month);
  res.json({
    month,
    paid: round2(stats.paid),
    cash: round2(stats.cash),
    card: round2(stats.card),
    transfer: round2(stats.transfer),
    newDebts: round2(stats.newDebts),
    returns: round2(stats.returns),
    totalDebt: round2(totalDebt),
    vat,
    sales: round2(salesStats.total),
    salesVat: round2(salesStats.vat),
    salesCount: salesStats.cnt,
    purchases: round2(purchStats.total),
    purchasesCount: purchStats.cnt,
    topShops: ranked.slice(0, 5),
    settings: getSettings(),
  });
});

// ============ استيراد إكسل ============
router.post('/import/preview', upload.single('file'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'لم يتم رفع ملف' });
  try {
    const wb = XLSX.readFile(req.file.path);
    const ws = wb.Sheets[wb.SheetNames[0]];
    const rows = XLSX.utils.sheet_to_json(ws, { header: 1, defval: '' });
    const headers = (rows[0] || []).map((h) => String(h).trim());
    const sample = rows.slice(1, 6);
    fs.unlink(req.file.path, () => {});
    res.json({ headers, sample, totalRows: Math.max(0, rows.length - 1) });
  } catch (err) {
    fs.unlink(req.file.path, () => {});
    res.status(400).json({ error: 'تعذّر قراءة الملف: ' + err.message });
  }
});

router.post('/import/commit', upload.single('file'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'لم يتم رفع ملف' });
  let mapping = {};
  try { mapping = JSON.parse(req.body.mapping || '{}'); } catch (_) {}
  const shopName = (req.body.shop_name || '').trim();
  try {
    createBackup('pre-import');
    const wb = XLSX.readFile(req.file.path);
    const ws = wb.Sheets[wb.SheetNames[0]];
    const rows = XLSX.utils.sheet_to_json(ws, { defval: '' });
    fs.unlink(req.file.path, () => {});

    // إن لم يُحدَّد عمود للمحل، تُدخل كل الصفوف في محل واحد
    let defaultShopId = null;
    if (!mapping.shop) {
      const name = shopName || 'محل مستورد من إكسل';
      let sh = db.prepare('SELECT id FROM shops WHERE name=?').get(name);
      if (!sh) { const info = db.prepare('INSERT INTO shops (name) VALUES (?)').run(name); defaultShopId = info.lastInsertRowid; }
      else defaultShopId = sh.id;
    }

    const findOrCreateShop = db.prepare('SELECT id FROM shops WHERE name=?');
    const createShop = db.prepare('INSERT INTO shops (name) VALUES (?)');
    const insertItem = db.prepare(`INSERT INTO entries (shop_id, kind, date, item_code, description, qty, price, amount, status) VALUES (?, 'item', ?, ?, ?, ?, ?, ?, 'due')`);
    const insertPayment = db.prepare(`INSERT INTO entries (shop_id, kind, date, amount) VALUES (?, 'payment', ?, ?)`);

    let imported = 0, payments = 0;
    const shopCache = new Map();

    const runImport = db.transaction((list) => {
      for (const r of list) {
        let shopId = defaultShopId;
        if (mapping.shop) {
          const sname = String(r[mapping.shop] || '').trim() || 'بدون اسم';
          if (shopCache.has(sname)) shopId = shopCache.get(sname);
          else {
            let sh = findOrCreateShop.get(sname);
            shopId = sh ? sh.id : createShop.run(sname).lastInsertRowid;
            shopCache.set(sname, shopId);
          }
        }
        const date = normDate(r[mapping.date]);
        const qty = num(r[mapping.qty]);
        const price = num(r[mapping.price]);
        let amount = num(r[mapping.amount]);
        if (!amount && qty && price) amount = round2(qty * price);
        const desc = String(r[mapping.description] || '').trim();
        const code = String(r[mapping.item_code] || '').trim();
        const payment = num(r[mapping.payment]);

        if (amount || desc || code || qty) {
          insertItem.run(shopId, date, code, desc, qty, price, round2(amount));
          imported++;
        }
        if (payment > 0) { insertPayment.run(shopId, date, round2(payment)); payments++; }
      }
    });
    runImport(rows);
    res.json({ ok: true, imported, payments });
  } catch (err) {
    fs.unlink(req.file.path, () => {});
    res.status(400).json({ error: 'فشل الاستيراد: ' + err.message });
  }
});

function num(v) { const n = Number(String(v).toString().replace(/[^\d.\-]/g, '')); return Number.isFinite(n) ? n : 0; }
function normDate(v) {
  if (!v) return new Date().toISOString().slice(0, 10);
  if (typeof v === 'number') { const d = XLSX.SSF ? XLSX.SSF.parse_date_code(v) : null; if (d) return `${d.y}-${String(d.m).padStart(2,'0')}-${String(d.d).padStart(2,'0')}`; }
  const s = String(v).trim();
  const m = s.match(/(\d{4})[-/](\d{1,2})[-/](\d{1,2})/);
  if (m) return `${m[1]}-${m[2].padStart(2,'0')}-${m[3].padStart(2,'0')}`;
  return s.slice(0, 10) || new Date().toISOString().slice(0, 10);
}

// ============ المخزون (الأصناف) ============
router.get('/products', (req, res) => {
  const search = (req.query.search || '').trim();
  const low = req.query.low === '1';
  let rows;
  if (search) {
    const like = `%${search}%`;
    rows = db.prepare('SELECT * FROM products WHERE name LIKE ? OR code LIKE ? ORDER BY name').all(like, like);
  } else {
    rows = db.prepare('SELECT * FROM products ORDER BY name').all();
  }
  if (low) rows = rows.filter((p) => p.stock <= p.low_threshold);
  res.json(rows);
});

router.post('/products', (req, res) => {
  const { code, name, unit, cost, price, stock, low_threshold } = req.body || {};
  if (!name || !name.trim()) return res.status(400).json({ error: 'اسم الصنف مطلوب' });
  const info = db.prepare('INSERT INTO products (code, name, unit, cost, price, stock, low_threshold) VALUES (?,?,?,?,?,?,?)')
    .run((code||'').trim(), name.trim(), (unit||'حبة').trim(), Number(cost)||0, Number(price)||0, Number(stock)||0, Number(low_threshold)||5);
  audit.log('إضافة صنف للمخزون', 'product', { id: info.lastInsertRowid, name: name.trim() });
  res.status(201).json({ id: info.lastInsertRowid });
});

router.put('/products/:id', (req, res) => {
  const p = db.prepare('SELECT * FROM products WHERE id=?').get(req.params.id);
  if (!p) return res.status(404).json({ error: 'الصنف غير موجود' });
  const { code, name, unit, cost, price, stock, low_threshold } = req.body || {};
  if (!name || !name.trim()) return res.status(400).json({ error: 'اسم الصنف مطلوب' });
  db.prepare('UPDATE products SET code=?, name=?, unit=?, cost=?, price=?, stock=?, low_threshold=? WHERE id=?')
    .run((code||'').trim(), name.trim(), (unit||'حبة').trim(), Number(cost)||0, Number(price)||0, Number(stock)||0, Number(low_threshold)||5, req.params.id);
  audit.log('تعديل صنف', 'product', { id: req.params.id, name: name.trim() });
  res.json({ ok: true });
});

router.delete('/products/:id', (req, res) => {
  db.prepare('DELETE FROM products WHERE id=?').run(req.params.id);
  audit.log('حذف صنف', 'product', { id: req.params.id });
  res.json({ ok: true });
});

// ============ المشتريات (تزيد المخزون) ============
router.get('/purchases', (req, res) => {
  const rows = db.prepare('SELECT * FROM purchases ORDER BY id DESC LIMIT 100').all();
  res.json(rows);
});

router.post('/purchases', (req, res) => {
  const { supplier, date, note, items } = req.body || {};
  if (!Array.isArray(items) || !items.length) return res.status(400).json({ error: 'أضف صنفاً واحداً على الأقل' });
  const d = (date && String(date).trim()) || new Date().toISOString().slice(0, 10);
  const tx = db.transaction(() => {
    let total = 0;
    const pInfo = db.prepare('INSERT INTO purchases (supplier, date, note, total) VALUES (?,?,?,0)').run((supplier||'').trim(), d, (note||'').trim());
    const pid = pInfo.lastInsertRowid;
    const insItem = db.prepare('INSERT INTO purchase_items (purchase_id, product_id, name, code, qty, cost, amount) VALUES (?,?,?,?,?,?,?)');
    const addStock = db.prepare('UPDATE products SET stock = stock + ?, cost = ? WHERE id=?');
    for (const it of items) {
      const qty = Number(it.qty) || 0, cost = Number(it.cost) || 0;
      if (qty <= 0) continue;
      const prod = it.product_id ? db.prepare('SELECT * FROM products WHERE id=?').get(it.product_id) : null;
      const amount = round2(qty * cost);
      insItem.run(pid, prod ? prod.id : null, prod ? prod.name : (it.name||''), prod ? prod.code : (it.code||''), qty, cost, amount);
      if (prod) addStock.run(qty, cost, prod.id);
      total += amount;
    }
    db.prepare('UPDATE purchases SET total=? WHERE id=?').run(round2(total), pid);
    return { pid, total: round2(total) };
  });
  const r = tx();
  audit.log('فاتورة شراء', 'purchase:' + r.pid, { supplier: (supplier||'').trim(), total: r.total });
  res.status(201).json({ ok: true, id: r.pid, total: r.total });
});

// ============ المبيعات / نقطة البيع (تنقص المخزون) ============
router.get('/sales', (req, res) => {
  const rows = db.prepare(`SELECT s.*, sh.name AS shop_name FROM sales s LEFT JOIN shops sh ON sh.id=s.shop_id ORDER BY s.id DESC LIMIT 100`).all();
  res.json(rows);
});

router.get('/sales/:id', (req, res) => {
  const sale = db.prepare(`SELECT s.*, sh.name AS shop_name, sh.phone AS shop_phone FROM sales s LEFT JOIN shops sh ON sh.id=s.shop_id WHERE s.id=?`).get(req.params.id);
  if (!sale) return res.status(404).json({ error: 'الفاتورة غير موجودة' });
  sale.items = db.prepare('SELECT * FROM sale_items WHERE sale_id=?').all(req.params.id);
  sale.settings = getSettings();
  res.json(sale);
});

router.post('/sales', (req, res) => {
  const { shop_id, customer_name, date, payment_type, apply_vat, items, note } = req.body || {};
  if (!Array.isArray(items) || !items.length) return res.status(400).json({ error: 'أضف صنفاً واحداً على الأقل' });
  const pt = ['cash','card','transfer','credit'].includes(payment_type) ? payment_type : 'cash';
  if (pt === 'credit' && !shop_id) return res.status(400).json({ error: 'البيع بالآجل يتطلب اختيار محل (زبون)' });
  const d = (date && String(date).trim()) || new Date().toISOString().slice(0, 10);
  const rate = Number(getSettings().vat_rate || 0);

  // تحقق من توفر المخزون
  for (const it of items) {
    if (!it.product_id) continue;
    const prod = db.prepare('SELECT * FROM products WHERE id=?').get(it.product_id);
    if (prod && Number(it.qty) > prod.stock) return res.status(400).json({ error: `الكمية غير متوفرة للصنف: ${prod.name} (المتوفر ${prod.stock})` });
  }

  const tx = db.transaction(() => {
    let subtotal = 0;
    const sInfo = db.prepare('INSERT INTO sales (shop_id, customer_name, date, payment_type, subtotal, vat, total, note) VALUES (?,?,?,?,0,0,0,?)')
      .run(shop_id || null, (customer_name||'').trim(), d, pt, (note||'').trim());
    const sid = sInfo.lastInsertRowid;
    const insItem = db.prepare('INSERT INTO sale_items (sale_id, product_id, name, code, qty, price, amount) VALUES (?,?,?,?,?,?,?)');
    const cutStock = db.prepare('UPDATE products SET stock = stock - ? WHERE id=?');
    for (const it of items) {
      const qty = Number(it.qty) || 0, price = Number(it.price) || 0;
      if (qty <= 0) continue;
      const prod = it.product_id ? db.prepare('SELECT * FROM products WHERE id=?').get(it.product_id) : null;
      const amount = round2(qty * price);
      insItem.run(sid, prod ? prod.id : null, prod ? prod.name : (it.name||''), prod ? prod.code : (it.code||''), qty, price, amount);
      if (prod) cutStock.run(qty, prod.id);
      subtotal += amount;
    }
    const vat = apply_vat ? round2(subtotal * rate / 100) : 0;
    const total = round2(subtotal + vat);
    db.prepare('UPDATE sales SET subtotal=?, vat=?, total=? WHERE id=?').run(round2(subtotal), vat, total, sid);

    // البيع بالآجل يزيد دين المحل كحركة بضاعة
    if (pt === 'credit' && shop_id) {
      db.prepare(`INSERT INTO entries (shop_id, kind, date, description, amount, status, note) VALUES (?, 'item', ?, ?, ?, 'due', ?)`)
        .run(shop_id, d, 'فاتورة بيع بالآجل #' + sid, total, 'بيع آجل');
    }
    return { sid, subtotal: round2(subtotal), vat, total };
  });
  const r = tx();
  audit.log('فاتورة بيع', 'sale:' + r.sid, { total: r.total, payment_type: pt, shop_id: shop_id || null });
  res.status(201).json({ ok: true, id: r.sid, ...r });
});

// ============ النسخ الاحتياطي ============
router.get('/backups', (req, res) => res.json(listBackups()));
router.post('/backups', (req, res) => { const f = createBackup('manual'); res.json({ ok: true, file: path.basename(f) }); });
router.get('/backups/download', (req, res) => {
  const name = path.basename(req.query.file || '');
  const full = path.join(BACKUP_DIR, name);
  if (!name || !fs.existsSync(full)) return res.status(404).json({ error: 'الملف غير موجود' });
  res.download(full);
});

// تصدير كامل JSON
router.get('/export', (req, res) => {
  const shops = db.prepare('SELECT * FROM shops').all();
  const entries = db.prepare('SELECT * FROM entries').all();
  res.setHeader('Content-Disposition', `attachment; filename="lucky-sky-export-${new Date().toISOString().slice(0,10)}.json"`);
  res.json({ exportedAt: new Date().toISOString(), settings: getSettings(), shops, entries });
});

module.exports = router;

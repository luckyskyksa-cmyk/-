const express = require('express');
const multer = require('multer');
const XLSX = require('xlsx');
const path = require('path');
const fs = require('fs');
const { db, DATA_DIR, dbPath, getSettings } = require('../db');
const { requireAuth } = require('../auth');
const { shopTotals, vatBreakdown, round2 } = require('../model');
const { createBackup, listBackups, BACKUP_DIR } = require('../backup');

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

  res.json({
    totalDebt: round2(totalDebt),
    shopsCount: shops.length,
    debtorsCount: ranked.filter((s) => s.balance > 0.001).length,
    month,
    monthPaid: round2(monthStats.paid),
    monthNewDebts: round2(monthStats.newDebts),
    monthReturns: round2(monthStats.returns),
    topShops: ranked.slice(0, 8),
    recent,
    settings: getSettings(),
  });
});

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
  const { name, code, phone, note } = req.body || {};
  if (!name || !name.trim()) return res.status(400).json({ error: 'اسم المحل مطلوب' });
  const info = db.prepare('INSERT INTO shops (name, code, phone, note) VALUES (?,?,?,?)').run(name.trim(), (code || '').trim(), (phone || '').trim(), (note || '').trim());
  res.status(201).json({ id: info.lastInsertRowid });
});

router.put('/shops/:id', (req, res) => {
  const s = db.prepare('SELECT * FROM shops WHERE id=?').get(req.params.id);
  if (!s) return res.status(404).json({ error: 'المحل غير موجود' });
  const { name, code, phone, note } = req.body || {};
  if (!name || !name.trim()) return res.status(400).json({ error: 'اسم المحل مطلوب' });
  db.prepare('UPDATE shops SET name=?, code=?, phone=?, note=? WHERE id=?').run(name.trim(), (code || '').trim(), (phone || '').trim(), (note || '').trim(), req.params.id);
  res.json({ ok: true });
});

router.delete('/shops/:id', (req, res) => {
  db.prepare('DELETE FROM shops WHERE id=?').run(req.params.id);
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
  res.json({ ...shop, totals, vat, entries, settings: getSettings() });
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
  res.status(201).json({ ok: true, balance: shopTotals(req.params.id).balance });
});

// تسجيل أصناف محددة كفاتورة خارجية (تُخصم من الإجمالي وتتلوّن)
router.post('/entries/invoice', (req, res) => {
  const { ids, invoice_no } = req.body || {};
  if (!Array.isArray(ids) || !ids.length) return res.status(400).json({ error: 'لم يتم تحديد أصناف' });
  const inv = (invoice_no || '').trim();
  const stmt = db.prepare("UPDATE entries SET status='invoiced', invoice_no=? WHERE id=? AND kind='item'");
  const tx = db.transaction((list) => { for (const id of list) stmt.run(inv, id); });
  tx(ids.map(Number));
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

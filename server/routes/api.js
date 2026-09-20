const express = require('express');
const { db } = require('../db');
const { requireAuth } = require('../auth');

const router = express.Router();

// All API routes below require authentication.
router.use(requireAuth);

function customerBalance(customerId) {
  const row = db
    .prepare(
      `SELECT
         COALESCE(SUM(CASE WHEN type = 'debt' THEN amount ELSE 0 END), 0) AS debts,
         COALESCE(SUM(CASE WHEN type = 'payment' THEN amount ELSE 0 END), 0) AS payments
       FROM transactions WHERE customer_id = ?`
    )
    .get(customerId);
  return (row.debts || 0) - (row.payments || 0);
}

// --- Dashboard summary ---
router.get('/summary', (req, res) => {
  const customersCount = db.prepare('SELECT COUNT(*) AS c FROM customers').get().c;
  const totals = db
    .prepare(
      `SELECT
         COALESCE(SUM(CASE WHEN type = 'debt' THEN amount ELSE 0 END), 0) AS debts,
         COALESCE(SUM(CASE WHEN type = 'payment' THEN amount ELSE 0 END), 0) AS payments
       FROM transactions`
    )
    .get();
  const totalOutstanding = (totals.debts || 0) - (totals.payments || 0);
  res.json({
    customersCount,
    totalDebts: totals.debts || 0,
    totalPayments: totals.payments || 0,
    totalOutstanding,
  });
});

// --- Customers ---
router.get('/customers', (req, res) => {
  const search = (req.query.search || '').trim();
  let rows;
  if (search) {
    const like = `%${search}%`;
    rows = db
      .prepare(
        `SELECT * FROM customers
         WHERE name LIKE ? OR phone LIKE ?
         ORDER BY name COLLATE NOCASE ASC`
      )
      .all(like, like);
  } else {
    rows = db
      .prepare('SELECT * FROM customers ORDER BY name COLLATE NOCASE ASC')
      .all();
  }
  const withBalance = rows.map((c) => ({ ...c, balance: customerBalance(c.id) }));
  res.json(withBalance);
});

router.get('/customers/:id', (req, res) => {
  const customer = db.prepare('SELECT * FROM customers WHERE id = ?').get(req.params.id);
  if (!customer) return res.status(404).json({ error: 'العميل غير موجود' });
  const transactions = db
    .prepare('SELECT * FROM transactions WHERE customer_id = ? ORDER BY date DESC, id DESC')
    .all(req.params.id);
  res.json({ ...customer, balance: customerBalance(customer.id), transactions });
});

router.post('/customers', (req, res) => {
  const { name, phone, note } = req.body || {};
  if (!name || !name.trim()) {
    return res.status(400).json({ error: 'اسم العميل مطلوب' });
  }
  const info = db
    .prepare('INSERT INTO customers (name, phone, note) VALUES (?, ?, ?)')
    .run(name.trim(), (phone || '').trim(), (note || '').trim());
  const customer = db.prepare('SELECT * FROM customers WHERE id = ?').get(info.lastInsertRowid);
  res.status(201).json({ ...customer, balance: 0 });
});

router.put('/customers/:id', (req, res) => {
  const { name, phone, note } = req.body || {};
  const existing = db.prepare('SELECT * FROM customers WHERE id = ?').get(req.params.id);
  if (!existing) return res.status(404).json({ error: 'العميل غير موجود' });
  if (!name || !name.trim()) {
    return res.status(400).json({ error: 'اسم العميل مطلوب' });
  }
  db.prepare('UPDATE customers SET name = ?, phone = ?, note = ? WHERE id = ?').run(
    name.trim(),
    (phone || '').trim(),
    (note || '').trim(),
    req.params.id
  );
  const customer = db.prepare('SELECT * FROM customers WHERE id = ?').get(req.params.id);
  res.json({ ...customer, balance: customerBalance(customer.id) });
});

router.delete('/customers/:id', (req, res) => {
  const existing = db.prepare('SELECT * FROM customers WHERE id = ?').get(req.params.id);
  if (!existing) return res.status(404).json({ error: 'العميل غير موجود' });
  db.prepare('DELETE FROM customers WHERE id = ?').run(req.params.id);
  res.json({ ok: true });
});

// --- Transactions ---
router.post('/customers/:id/transactions', (req, res) => {
  const customer = db.prepare('SELECT * FROM customers WHERE id = ?').get(req.params.id);
  if (!customer) return res.status(404).json({ error: 'العميل غير موجود' });
  const { amount, type, note, date } = req.body || {};
  const amt = Number(amount);
  if (!Number.isFinite(amt) || amt <= 0) {
    return res.status(400).json({ error: 'المبلغ يجب أن يكون رقمًا أكبر من صفر' });
  }
  if (type !== 'debt' && type !== 'payment') {
    return res.status(400).json({ error: 'نوع الحركة غير صحيح' });
  }
  const txDate = date && String(date).trim() ? String(date).trim() : new Date().toISOString().slice(0, 10);
  const info = db
    .prepare(
      'INSERT INTO transactions (customer_id, amount, type, note, date) VALUES (?, ?, ?, ?, ?)'
    )
    .run(req.params.id, amt, type, (note || '').trim(), txDate);
  const tx = db.prepare('SELECT * FROM transactions WHERE id = ?').get(info.lastInsertRowid);
  res.status(201).json({ transaction: tx, balance: customerBalance(req.params.id) });
});

router.delete('/transactions/:txId', (req, res) => {
  const tx = db.prepare('SELECT * FROM transactions WHERE id = ?').get(req.params.txId);
  if (!tx) return res.status(404).json({ error: 'الحركة غير موجودة' });
  db.prepare('DELETE FROM transactions WHERE id = ?').run(req.params.txId);
  res.json({ ok: true, balance: customerBalance(tx.customer_id) });
});

// --- Backup / export (data safety) ---
router.get('/backup', (req, res) => {
  const customers = db.prepare('SELECT * FROM customers').all();
  const transactions = db.prepare('SELECT * FROM transactions').all();
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader(
    'Content-Disposition',
    `attachment; filename="lucky-sky-backup-${new Date().toISOString().slice(0, 10)}.json"`
  );
  res.json({ exportedAt: new Date().toISOString(), customers, transactions });
});

module.exports = router;

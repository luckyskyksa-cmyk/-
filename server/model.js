const { db, getSettings } = require('./db');

// حساب رصيد محل: (بضاعة مستحقة) - (الدفعات) - (المرتجعات)
// البضاعة المسجّلة بفاتورة خارجية (invoiced) لا تُحتسب في الدين.
function shopTotals(shopId) {
  const r = db
    .prepare(
      `SELECT
        COALESCE(SUM(CASE WHEN kind='item' AND status='due' THEN amount ELSE 0 END),0) AS due_items,
        COALESCE(SUM(CASE WHEN kind='item' AND status='invoiced' THEN amount ELSE 0 END),0) AS invoiced,
        COALESCE(SUM(CASE WHEN kind='payment' THEN amount ELSE 0 END),0) AS payments,
        COALESCE(SUM(CASE WHEN kind='return' THEN amount ELSE 0 END),0) AS returns
      FROM entries WHERE shop_id=?`
    )
    .get(shopId);
  const balance = r.due_items - r.payments - r.returns;
  return {
    dueItems: r.due_items,
    invoiced: r.invoiced,
    payments: r.payments,
    returns: r.returns,
    balance,
  };
}

function vatBreakdown(amountInclusive) {
  const rate = Number(getSettings().vat_rate || 0) / 100;
  if (!rate) return { base: amountInclusive, vat: 0, total: amountInclusive, rate: 0 };
  const base = amountInclusive / (1 + rate);
  return {
    base: round2(base),
    vat: round2(amountInclusive - base),
    total: round2(amountInclusive),
    rate: rate * 100,
  };
}

function round2(n) {
  return Math.round((Number(n) + Number.EPSILON) * 100) / 100;
}

module.exports = { shopTotals, vatBreakdown, round2 };

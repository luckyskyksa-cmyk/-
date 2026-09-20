const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');

const DATA_DIR = process.env.LUCKY_SKY_DATA_DIR || path.join(__dirname, '..', 'data');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

const dbPath = path.join(DATA_DIR, 'lucky-sky.db');
const db = new Database(dbPath);

// إعدادات موثوقية وأداء مناسبة لعدة أجهزة وبيانات كبيرة (20 ألف+)
db.pragma('journal_mode = WAL');
db.pragma('synchronous = NORMAL');
db.pragma('foreign_keys = ON');

db.exec(`
  CREATE TABLE IF NOT EXISTS shops (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    code TEXT,
    name TEXT NOT NULL,
    phone TEXT DEFAULT '',
    note TEXT DEFAULT '',
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  -- كل الحركات: بضاعة (دين) / دفعة / مرتجع
  CREATE TABLE IF NOT EXISTS entries (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    shop_id INTEGER NOT NULL,
    kind TEXT NOT NULL CHECK (kind IN ('item','payment','return')),
    date TEXT NOT NULL DEFAULT (date('now')),
    item_code TEXT DEFAULT '',
    description TEXT DEFAULT '',
    qty REAL DEFAULT 0,
    price REAL DEFAULT 0,
    amount REAL NOT NULL DEFAULT 0,
    -- لحركة البضاعة: due (مستحق) أو invoiced (خرج بفاتورة خارجية فيُخصم من الإجمالي)
    status TEXT DEFAULT 'due' CHECK (status IN ('due','invoiced')),
    invoice_no TEXT DEFAULT '',
    payment_method TEXT DEFAULT '' CHECK (payment_method IN ('','cash','card','transfer')),
    note TEXT DEFAULT '',
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (shop_id) REFERENCES shops(id) ON DELETE CASCADE
  );

  CREATE INDEX IF NOT EXISTS idx_entries_shop ON entries(shop_id);
  CREATE INDEX IF NOT EXISTS idx_entries_kind ON entries(shop_id, kind);
  CREATE INDEX IF NOT EXISTS idx_entries_date ON entries(date);
  CREATE INDEX IF NOT EXISTS idx_entries_status ON entries(status);
  CREATE INDEX IF NOT EXISTS idx_entries_code ON entries(item_code);
  CREATE INDEX IF NOT EXISTS idx_shops_name ON shops(name);

  CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT
  );

  CREATE TABLE IF NOT EXISTS audit_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    action TEXT NOT NULL,
    entity TEXT DEFAULT '',
    details TEXT DEFAULT '',
    at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_audit_at ON audit_log(at);
`);

// ترحيلات آمنة لإضافة أعمدة جديدة دون فقدان البيانات
function ensureColumn(table, column, def) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all();
  if (!cols.some((c) => c.name === column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${def}`);
  }
}
ensureColumn('shops', 'credit_limit', 'REAL DEFAULT 0');

// إعدادات افتراضية
const setDefault = db.prepare('INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)');
setDefault.run('currency', 'ر.س');
setDefault.run('vat_rate', '15');
setDefault.run('business_name', 'لاكي سكاي');

function getSettings() {
  const rows = db.prepare('SELECT key, value FROM settings').all();
  const s = {};
  for (const r of rows) s[r.key] = r.value;
  return s;
}

module.exports = { db, DATA_DIR, dbPath, getSettings };

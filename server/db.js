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

  -- المخزون: الأصناف وكمياتها
  CREATE TABLE IF NOT EXISTS products (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    code TEXT DEFAULT '',
    name TEXT NOT NULL,
    unit TEXT DEFAULT 'حبة',
    cost REAL DEFAULT 0,
    price REAL DEFAULT 0,
    stock REAL DEFAULT 0,
    low_threshold REAL DEFAULT 5,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_products_name ON products(name);
  CREATE INDEX IF NOT EXISTS idx_products_code ON products(code);

  -- فواتير الشراء (تزيد المخزون)
  CREATE TABLE IF NOT EXISTS purchases (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    supplier TEXT DEFAULT '',
    date TEXT NOT NULL DEFAULT (date('now')),
    note TEXT DEFAULT '',
    total REAL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE TABLE IF NOT EXISTS purchase_items (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    purchase_id INTEGER NOT NULL,
    product_id INTEGER,
    name TEXT DEFAULT '',
    code TEXT DEFAULT '',
    qty REAL DEFAULT 0,
    cost REAL DEFAULT 0,
    amount REAL DEFAULT 0,
    FOREIGN KEY (purchase_id) REFERENCES purchases(id) ON DELETE CASCADE
  );
  CREATE INDEX IF NOT EXISTS idx_pitems_purchase ON purchase_items(purchase_id);

  -- فواتير البيع (تنقص المخزون؛ الآجل يزيد دين المحل)
  CREATE TABLE IF NOT EXISTS sales (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    shop_id INTEGER,
    customer_name TEXT DEFAULT '',
    date TEXT NOT NULL DEFAULT (date('now')),
    payment_type TEXT DEFAULT 'cash' CHECK (payment_type IN ('cash','card','transfer','credit')),
    subtotal REAL DEFAULT 0,
    vat REAL DEFAULT 0,
    total REAL DEFAULT 0,
    note TEXT DEFAULT '',
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (shop_id) REFERENCES shops(id) ON DELETE SET NULL
  );
  CREATE TABLE IF NOT EXISTS sale_items (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    sale_id INTEGER NOT NULL,
    product_id INTEGER,
    name TEXT DEFAULT '',
    code TEXT DEFAULT '',
    qty REAL DEFAULT 0,
    price REAL DEFAULT 0,
    amount REAL DEFAULT 0,
    FOREIGN KEY (sale_id) REFERENCES sales(id) ON DELETE CASCADE
  );
  CREATE INDEX IF NOT EXISTS idx_sitems_sale ON sale_items(sale_id);
  CREATE INDEX IF NOT EXISTS idx_sales_date ON sales(date);
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

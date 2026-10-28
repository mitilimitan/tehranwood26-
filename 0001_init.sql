-- 0001_init.sql  (Cloudflare D1 / SQLite)
-- Money: INTEGER in the smallest store unit (default: rial). Unit/display come from store_settings.

CREATE TABLE store_settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  telegram_id INTEGER NOT NULL UNIQUE,
  first_name TEXT,
  username TEXT,
  phone TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE admins (
  telegram_id INTEGER PRIMARY KEY,
  role TEXT NOT NULL CHECK (role IN ('admin','operator')),  -- owner comes from env OWNER_TELEGRAM_ID, never from DB
  extra_permissions TEXT NOT NULL DEFAULT '[]',              -- JSON array of permission keys
  is_active INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0,1)),
  added_by INTEGER NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE categories (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  parent_id INTEGER REFERENCES categories(id),
  name TEXT NOT NULL,
  description TEXT,
  image_key TEXT,                       -- R2 object key
  sort_order INTEGER NOT NULL DEFAULT 0,
  is_active INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0,1))
);
CREATE INDEX idx_categories_parent ON categories(parent_id, sort_order);

CREATE TABLE products (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  brand TEXT,
  description TEXT,
  attributes TEXT NOT NULL DEFAULT '{}',   -- JSON: future color code, gloss, usage...
  is_published INTEGER NOT NULL DEFAULT 0 CHECK (is_published IN (0,1)),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE product_categories (
  product_id INTEGER NOT NULL REFERENCES products(id),
  category_id INTEGER NOT NULL REFERENCES categories(id),
  PRIMARY KEY (product_id, category_id)
);

CREATE TABLE product_images (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  product_id INTEGER NOT NULL REFERENCES products(id),
  image_key TEXT NOT NULL,
  sort_order INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE product_variants (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  product_id INTEGER NOT NULL REFERENCES products(id),
  sku TEXT NOT NULL UNIQUE,
  label TEXT NOT NULL,                     -- e.g. "4 لیتری"
  unit TEXT NOT NULL DEFAULT 'L',
  size_value REAL,
  price INTEGER NOT NULL CHECK (price >= 0),
  stock_on_hand INTEGER NOT NULL DEFAULT 0 CHECK (stock_on_hand >= 0),
  stock_reserved INTEGER NOT NULL DEFAULT 0 CHECK (stock_reserved >= 0),
  is_active INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0,1)),
  is_sellable INTEGER NOT NULL DEFAULT 1 CHECK (is_sellable IN (0,1)),  -- temporary "out of stock" switch
  attributes TEXT NOT NULL DEFAULT '{}',
  CHECK (stock_reserved <= stock_on_hand)  -- over-reservation raises an error and aborts a db.batch()
);
CREATE INDEX idx_variants_product ON product_variants(product_id);

CREATE TABLE inventory_movements (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  variant_id INTEGER NOT NULL REFERENCES product_variants(id),
  delta_on_hand INTEGER NOT NULL DEFAULT 0,
  delta_reserved INTEGER NOT NULL DEFAULT 0,
  reason TEXT NOT NULL,                    -- reserve|release|sale|adjust|restock
  order_id INTEGER,
  actor_telegram_id INTEGER,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_invmov_variant ON inventory_movements(variant_id, created_at);

CREATE TABLE carts (
  user_id INTEGER PRIMARY KEY REFERENCES users(id),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE cart_items (
  user_id INTEGER NOT NULL REFERENCES carts(user_id),
  variant_id INTEGER NOT NULL REFERENCES product_variants(id),
  quantity INTEGER NOT NULL CHECK (quantity > 0 AND quantity <= 999),
  PRIMARY KEY (user_id, variant_id)
);

CREATE TABLE orders (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  public_code TEXT NOT NULL UNIQUE,
  user_id INTEGER NOT NULL REFERENCES users(id),
  status TEXT NOT NULL DEFAULT 'pending_payment'
    CHECK (status IN ('pending_payment','paid','processing','shipped','delivered','cancelled','expired')),
  payment_status TEXT NOT NULL DEFAULT 'unpaid'
    CHECK (payment_status IN ('unpaid','awaiting_review','paid','rejected','refunded')),
  subtotal INTEGER NOT NULL CHECK (subtotal >= 0),
  discount INTEGER NOT NULL DEFAULT 0 CHECK (discount >= 0),
  total INTEGER NOT NULL CHECK (total >= 0),
  currency TEXT NOT NULL,
  delivery_info TEXT NOT NULL DEFAULT '{}',   -- JSON: name, phone, address (minimal)
  reserved_until TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  CHECK (total = subtotal - discount)
);
CREATE INDEX idx_orders_user ON orders(user_id, created_at);
CREATE INDEX idx_orders_status ON orders(status, reserved_until);

CREATE TABLE order_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  order_id INTEGER NOT NULL REFERENCES orders(id),
  variant_id INTEGER NOT NULL REFERENCES product_variants(id),
  product_name TEXT NOT NULL,       -- snapshot
  variant_label TEXT NOT NULL,      -- snapshot
  sku TEXT NOT NULL,                -- snapshot
  unit_price INTEGER NOT NULL CHECK (unit_price >= 0),  -- snapshot
  quantity INTEGER NOT NULL CHECK (quantity > 0)
);
CREATE INDEX idx_order_items_order ON order_items(order_id);

CREATE TABLE order_status_history (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  order_id INTEGER NOT NULL REFERENCES orders(id),
  from_status TEXT, to_status TEXT NOT NULL,
  actor TEXT NOT NULL,              -- 'system' | 'gateway' | telegram id
  note TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE payments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  order_id INTEGER NOT NULL REFERENCES orders(id),
  method TEXT NOT NULL DEFAULT 'manual_receipt',   -- later: 'gateway:<name>' without schema change
  amount INTEGER NOT NULL CHECK (amount > 0),      -- expected amount, copied from order.total
  currency TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'submitted'
    CHECK (status IN ('submitted','approved','rejected','refunded')),
  receipt_file_id TEXT NOT NULL,                   -- Telegram file_id (image stays on Telegram)
  receipt_unique_id TEXT NOT NULL,                 -- Telegram file_unique_id: same photo cannot be reused
  reviewed_by INTEGER,                             -- admin telegram id
  reviewed_at TEXT,
  reject_reason TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  CHECK ((status = 'submitted') = (reviewed_by IS NULL))
);
-- One receipt awaiting review per order; one approved payment per order; a photo is usable once
CREATE UNIQUE INDEX uq_payments_one_submitted ON payments(order_id) WHERE status = 'submitted';
CREATE UNIQUE INDEX uq_payments_one_approved ON payments(order_id) WHERE status = 'approved';
CREATE UNIQUE INDEX uq_payments_receipt_photo ON payments(receipt_unique_id) WHERE status IN ('submitted','approved');

CREATE TABLE price_change_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  variant_id INTEGER NOT NULL REFERENCES product_variants(id),
  old_price INTEGER NOT NULL, new_price INTEGER NOT NULL,
  batch_id TEXT,                    -- groups a bulk percent change
  actor_telegram_id INTEGER NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE audit_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  actor_telegram_id INTEGER,
  action TEXT NOT NULL,
  target TEXT,
  detail TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Telegram sends each update once but retries on non-200: dedupe by update_id
CREATE TABLE processed_updates (
  update_id INTEGER PRIMARY KEY,
  processed_at TEXT NOT NULL DEFAULT (datetime('now'))
);

// Paint Shop Bot — Stage 3: roles, admins, categories, products, variants, prices, stock (single file, no dependencies).
// Bindings/secrets: DB (D1), BOT_TOKEN, WEBHOOK_SECRET, OWNER_TELEGRAM_ID, SETUP_KEY

const MAX_BODY_BYTES = 64 * 1024;
const STATE_TTL_MS = 30 * 60 * 1000;
const MAX_CATEGORY_DEPTH = 3;
const MAX_VARIANTS_PER_PRODUCT = 20;
const MAX_SPECS = 30;
const MAX_BULK_ITEMS = 50;
const PAGE_SIZE = 8;

// ───────────────────────── utilities ─────────────────────────
class UserError extends Error {}

function safeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

async function tg(env, method, payload) {
  // Never log the URL: it contains the bot token.
  const res = await fetch(`https://api.telegram.org/bot${env.BOT_TOKEN}/${method}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  });
  return res.json();
}

function cleanName(input) {
  const name = String(input ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim();
  if (name.length < 1) throw new UserError('نام نمی‌تواند خالی باشد.');
  if (name.length > 60) throw new UserError('نام حداکثر ۶۰ کاراکتر می‌تواند باشد.');
  return name;
}

// ───────────────────────── access control ─────────────────────────
const ROLE_PERMS = {
  admin: ['catalog.manage', 'price.manage', 'stock.manage', 'orders.manage', 'payments.review', 'reports.view'],
  operator: ['orders.manage'],
};
const ALL_PERMS = [...ROLE_PERMS.admin, 'admins.manage', 'settings.manage'];

function isOwner(env, userId) {
  return env.OWNER_TELEGRAM_ID != null && String(userId) === String(env.OWNER_TELEGRAM_ID);
}

// Real permission lookup. Called on EVERY sensitive action (hiding buttons is not security).
async function getAccess(env, userId) {
  if (isOwner(env, userId)) return { role: 'owner', has: () => true };
  const row = await env.DB.prepare(
    'SELECT role, extra_permissions FROM admins WHERE telegram_id = ?1 AND is_active = 1'
  ).bind(userId).first();
  if (!row) return null;
  let extra = [];
  try { extra = JSON.parse(row.extra_permissions); } catch { /* ignore bad JSON */ }
  const set = new Set([...(ROLE_PERMS[row.role] ?? []), ...extra.filter((p) => ALL_PERMS.includes(p))]);
  return { role: row.role, has: (p) => set.has(p) };
}

async function requirePerm(env, userId, perm) {
  const access = await getAccess(env, userId);
  if (!access || !access.has(perm)) throw new UserError('شما دسترسی لازم برای این کار را ندارید.');
  return access;
}

// ───────────────────────── core: categories (no Telegram here) ─────────────────────────
const Categories = {
  async get(env, id) {
    return env.DB.prepare('SELECT * FROM categories WHERE id = ?1').bind(id).first();
  },
  async children(env, parentId, { onlyActive = false } = {}) {
    const sql = `SELECT * FROM categories WHERE parent_id IS ?1 ${onlyActive ? 'AND is_active = 1' : ''} ORDER BY sort_order, id`;
    return (await env.DB.prepare(sql).bind(parentId).all()).results;
  },
  async depth(env, id) {
    let depth = 0, cur = id;
    while (cur != null && depth < 10) {
      const row = await Categories.get(env, cur);
      if (!row) break;
      depth++; cur = row.parent_id;
    }
    return depth;
  },
  async audit(env, actor, action, target, detail) {
    await env.DB.prepare('INSERT INTO audit_logs (actor_telegram_id, action, target, detail) VALUES (?1, ?2, ?3, ?4)')
      .bind(actor, action, String(target), detail ?? null).run();
  },
  async create(env, actor, { parentId, name }) {
    await requirePerm(env, actor, 'catalog.manage');
    const clean = cleanName(name);
    if (parentId != null) {
      const parent = await Categories.get(env, parentId);
      if (!parent) throw new UserError('دسته‌ی والد پیدا نشد.');
      if ((await Categories.depth(env, parentId)) >= MAX_CATEGORY_DEPTH) throw new UserError('حداکثر ۳ سطح دسته‌بندی مجاز است.');
    }
    const max = await env.DB.prepare('SELECT COALESCE(MAX(sort_order), 0) AS m FROM categories WHERE parent_id IS ?1').bind(parentId).first();
    const res = await env.DB.prepare('INSERT INTO categories (parent_id, name, sort_order) VALUES (?1, ?2, ?3)')
      .bind(parentId, clean, max.m + 1).run();
    const id = res.meta?.last_row_id;
    await Categories.audit(env, actor, 'category.create', id, clean);
    return id;
  },
  async rename(env, actor, id, name) {
    await requirePerm(env, actor, 'catalog.manage');
    const clean = cleanName(name);
    const res = await env.DB.prepare('UPDATE categories SET name = ?1 WHERE id = ?2').bind(clean, id).run();
    if (!res.meta?.changes) throw new UserError('دسته پیدا نشد.');
    await Categories.audit(env, actor, 'category.rename', id, clean);
  },
  async toggle(env, actor, id) {
    await requirePerm(env, actor, 'catalog.manage');
    const res = await env.DB.prepare('UPDATE categories SET is_active = 1 - is_active WHERE id = ?1').bind(id).run();
    if (!res.meta?.changes) throw new UserError('دسته پیدا نشد.');
    const row = await Categories.get(env, id);
    await Categories.audit(env, actor, 'category.toggle', id, row.is_active ? 'active' : 'inactive');
    return row.is_active === 1;
  },
  async move(env, actor, id, dir) {
    await requirePerm(env, actor, 'catalog.manage');
    const cat = await Categories.get(env, id);
    if (!cat) throw new UserError('دسته پیدا نشد.');
    const siblings = (await Categories.children(env, cat.parent_id)).map((c) => c.id);
    const i = siblings.indexOf(id), j = dir === 'up' ? i - 1 : i + 1;
    if (j < 0 || j >= siblings.length) return false;
    [siblings[i], siblings[j]] = [siblings[j], siblings[i]];
    await env.DB.batch(siblings.map((sid, idx) =>
      env.DB.prepare('UPDATE categories SET sort_order = ?1 WHERE id = ?2').bind(idx + 1, sid)));
    await Categories.audit(env, actor, 'category.move', id, dir);
    return true;
  },
};

// ───────────────────────── conversation state ─────────────────────────
const State = {
  async set(env, userId, action, payload) {
    await env.DB.prepare(
      `INSERT INTO conversation_state (telegram_id, action, payload, updated_at) VALUES (?1, ?2, ?3, datetime('now'))
       ON CONFLICT(telegram_id) DO UPDATE SET action = ?2, payload = ?3, updated_at = datetime('now')`
    ).bind(userId, action, JSON.stringify(payload ?? {})).run();
  },
  async get(env, userId) {
    const row = await env.DB.prepare('SELECT action, payload, updated_at FROM conversation_state WHERE telegram_id = ?1').bind(userId).first();
    if (!row) return null;
    const age = Date.now() - Date.parse(row.updated_at.replace(' ', 'T') + 'Z');
    if (!(age < STATE_TTL_MS)) { await State.clear(env, userId); return null; }
    let payload = {};
    try { payload = JSON.parse(row.payload); } catch { /* ignore */ }
    return { action: row.action, payload };
  },
  async clear(env, userId) {
    await env.DB.prepare('DELETE FROM conversation_state WHERE telegram_id = ?1').bind(userId).run();
  },
};

// ───────────────────────── input helpers ─────────────────────────
function normalizeDigits(input) {
  return String(input ?? '')
    .replace(/[۰-۹]/g, (d) => String('۰۱۲۳۴۵۶۷۸۹'.indexOf(d)))
    .replace(/[٠-٩]/g, (d) => String('٠١٢٣٤٥٦٧٨٩'.indexOf(d)))
    .replace(/[٬،,\s]/g, '')
    .replace(/٫/g, '.');
}
function parseIntIn(text, { min, max, label }) {
  const s = normalizeDigits(text);
  if (!/^\d{1,15}$/.test(s)) throw new UserError(`${label} باید یک عدد صحیح باشد.`);
  const n = Number(s);
  if (n < min || n > max) throw new UserError(`${label} باید بین ${fmt(min)} و ${fmt(max)} باشد.`);
  return n;
}
function parseDecimalIn(text, { min, max, label }) {
  const s = normalizeDigits(text).replace(/^−/, '-');
  if (!/^-?\d{1,6}(\.\d{1,3})?$/.test(s)) throw new UserError(`${label} باید عدد باشد (مثلاً 5 یا -3.5).`);
  const n = Number(s);
  if (n < min || n > max) throw new UserError(`${label} باید بین ${min} و ${max} باشد.`);
  return n;
}
function cleanText(input, { min = 1, max, label }) {
  const t = String(input ?? '').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, ' ').trim();
  if (t.length < min) throw new UserError(`${label} نمی‌تواند خالی باشد.`);
  if (t.length > max) throw new UserError(`${label} حداکثر ${fmt(max)} کاراکتر می‌تواند باشد.`);
  return t;
}
const isSkip = (t) => ['-', '—', 'ندارد'].includes(String(t ?? '').trim());
const NUMBER_FORMAT = new Intl.NumberFormat('fa-IR');
const fmt = (n) => NUMBER_FORMAT.format(n);
const clip = (t) => (t.length > 3900 ? t.slice(0, 3900) + '…' : t);
async function currencyLabel(env) {
  const r = await env.DB.prepare("SELECT value FROM store_settings WHERE key = 'currency_label'").first();
  return r?.value || 'تومان';
}
const personLabel = (u) => `${u.first_name ?? 'بدون نام'}${u.username ? ' @' + u.username : ''} (${u.telegram_id})`;
const uniqueViolation = (err) => /UNIQUE/i.test(String(err?.message ?? ''));
const constraintViolation = (err) => /constraint/i.test(String(err?.message ?? ''));

function requireOwner(env, userId) {
  if (!isOwner(env, userId)) throw new UserError('فقط مالک اصلی می‌تواند ادمین‌ها را مدیریت کند.');
}
async function requireAnyPerm(env, userId, perms) {
  const access = await getAccess(env, userId);
  if (!access || !perms.some((p) => access.has(p))) throw new UserError('شما دسترسی لازم برای این کار را ندارید.');
  return access;
}
const BROWSE_PERMS = ['catalog.manage', 'price.manage', 'stock.manage'];

async function audit(env, actor, action, target, detail) {
  await env.DB.prepare('INSERT INTO audit_logs (actor_telegram_id, action, target, detail) VALUES (?1, ?2, ?3, ?4)')
    .bind(actor, action, String(target), detail ?? null).run();
}

// ───────────────────────── core: admins (owner only) ─────────────────────────
const Admins = {
  async list(env) {
    return (await env.DB.prepare(
      `SELECT a.telegram_id, a.role, a.is_active, u.first_name, u.username FROM admins a
       LEFT JOIN users u ON u.telegram_id = a.telegram_id ORDER BY a.created_at, a.telegram_id`).all()).results;
  },
  async get(env, id) {
    return env.DB.prepare(
      `SELECT a.telegram_id, a.role, a.is_active, u.first_name, u.username FROM admins a
       LEFT JOIN users u ON u.telegram_id = a.telegram_id WHERE a.telegram_id = ?1`).bind(id).first();
  },
  async recentUsers(env) {
    const rows = (await env.DB.prepare(
      `SELECT telegram_id, first_name, username FROM users
       WHERE telegram_id NOT IN (SELECT telegram_id FROM admins) ORDER BY id DESC LIMIT 12`).all()).results;
    return rows.filter((u) => !isOwner(env, u.telegram_id)).slice(0, 10);
  },
  validateId(id) {
    if (!Number.isSafeInteger(id) || id <= 0) throw new UserError('شناسه‌ی تلگرام نامعتبر است.');
    return id;
  },
  async upsert(env, actor, id, role) {
    requireOwner(env, actor);
    Admins.validateId(id);
    if (!ROLE_PERMS[role]) throw new UserError('نقش نامعتبر است.');
    if (isOwner(env, id)) throw new UserError('مالک اصلی نیازی به ثبت به‌عنوان ادمین ندارد.');
    await env.DB.prepare(
      `INSERT INTO admins (telegram_id, role, is_active, added_by) VALUES (?1, ?2, 1, ?3)
       ON CONFLICT(telegram_id) DO UPDATE SET role = ?2, is_active = 1`).bind(id, role, actor).run();
    await audit(env, actor, 'admin.upsert', id, role);
  },
  async setActive(env, actor, id, active) {
    requireOwner(env, actor);
    if (isOwner(env, id)) throw new UserError('مالک اصلی قابل تغییر نیست.');
    const r = await env.DB.prepare('UPDATE admins SET is_active = ?1 WHERE telegram_id = ?2').bind(active ? 1 : 0, id).run();
    if (!r.meta?.changes) throw new UserError('این ادمین پیدا نشد.');
    await audit(env, actor, active ? 'admin.activate' : 'admin.deactivate', id, null);
  },
};

// ───────────────────────── core: products ─────────────────────────
const Products = {
  async get(env, id) { return env.DB.prepare('SELECT * FROM products WHERE id = ?1').bind(id).first(); },
  async page(env, page) {
    const total = (await env.DB.prepare('SELECT COUNT(*) AS c FROM products').first()).c;
    const rows = (await env.DB.prepare('SELECT * FROM products ORDER BY id DESC LIMIT ?1 OFFSET ?2')
      .bind(PAGE_SIZE, page * PAGE_SIZE).all()).results;
    return { total, rows };
  },
  async create(env, actor, name) {
    await requirePerm(env, actor, 'catalog.manage');
    const clean = cleanText(name, { max: 100, label: 'نام محصول' });
    const r = await env.DB.prepare('INSERT INTO products (name) VALUES (?1)').bind(clean).run();
    await audit(env, actor, 'product.create', r.meta.last_row_id, clean);
    return r.meta.last_row_id;
  },
  async update(env, actor, id, field, raw) {
    await requirePerm(env, actor, 'catalog.manage');
    let value;
    if (field === 'name') value = cleanText(raw, { max: 100, label: 'نام محصول' });
    else if (field === 'brand') value = isSkip(raw) ? null : cleanText(raw, { max: 60, label: 'برند' });
    else if (field === 'description') value = isSkip(raw) ? null : cleanText(raw, { max: 1000, label: 'توضیحات' });
    else throw new UserError('فیلد نامعتبر است.');
    const r = await env.DB.prepare(`UPDATE products SET ${field} = ?1, updated_at = datetime('now') WHERE id = ?2`).bind(value, id).run();
    if (!r.meta?.changes) throw new UserError('محصول پیدا نشد.');
    await audit(env, actor, 'product.update', id, field);
  },
  specs(product) {
    try { const o = JSON.parse(product.attributes); return o && typeof o === 'object' && !Array.isArray(o) ? o : {}; } catch { return {}; }
  },
  async addSpec(env, actor, id, raw) {
    await requirePerm(env, actor, 'catalog.manage');
    const product = await Products.get(env, id);
    if (!product) throw new UserError('محصول پیدا نشد.');
    const m = String(raw ?? '').match(/^([^:：]+)[:：](.+)$/s);
    if (!m) throw new UserError('فرمت درست: «نام مشخصه: مقدار» مثلاً «رنگ: سفید».');
    const key = cleanText(m[1], { max: 40, label: 'نام مشخصه' });
    const value = cleanText(m[2], { max: 200, label: 'مقدار مشخصه' });
    const specs = Products.specs(product);
    if (!(key in specs) && Object.keys(specs).length >= MAX_SPECS) throw new UserError(`حداکثر ${fmt(MAX_SPECS)} مشخصه مجاز است.`);
    specs[key] = value;
    await env.DB.prepare("UPDATE products SET attributes = ?1, updated_at = datetime('now') WHERE id = ?2").bind(JSON.stringify(specs), id).run();
    await audit(env, actor, 'product.spec.add', id, key);
  },
  async clearSpecs(env, actor, id) {
    await requirePerm(env, actor, 'catalog.manage');
    await env.DB.prepare("UPDATE products SET attributes = '{}' WHERE id = ?1").bind(id).run();
    await audit(env, actor, 'product.spec.clear', id, null);
  },
  async togglePublish(env, actor, id) {
    await requirePerm(env, actor, 'catalog.manage');
    const r = await env.DB.prepare('UPDATE products SET is_published = 1 - is_published WHERE id = ?1').bind(id).run();
    if (!r.meta?.changes) throw new UserError('محصول پیدا نشد.');
    await audit(env, actor, 'product.publish.toggle', id, null);
  },
  async categories(env, id) {
    return (await env.DB.prepare(
      'SELECT c.id, c.name FROM categories c JOIN product_categories pc ON pc.category_id = c.id WHERE pc.product_id = ?1 ORDER BY c.name').bind(id).all()).results;
  },
  async toggleCategory(env, actor, pid, cid) {
    await requirePerm(env, actor, 'catalog.manage');
    if (!(await Products.get(env, pid)) || !(await Categories.get(env, cid))) throw new UserError('محصول یا دسته پیدا نشد.');
    const del = await env.DB.prepare('DELETE FROM product_categories WHERE product_id = ?1 AND category_id = ?2').bind(pid, cid).run();
    if (!del.meta?.changes) await env.DB.prepare('INSERT INTO product_categories (product_id, category_id) VALUES (?1, ?2)').bind(pid, cid).run();
    await audit(env, actor, 'product.category.toggle', pid, String(cid));
  },
  async variants(env, pid, { onlyActive = false } = {}) {
    return (await env.DB.prepare(`SELECT * FROM product_variants WHERE product_id = ?1 ${onlyActive ? 'AND is_active = 1' : ''} ORDER BY id`).bind(pid).all()).results;
  },
  async publishedInCategory(env, cid) {
    return (await env.DB.prepare(
      `SELECT p.* FROM products p JOIN product_categories pc ON pc.product_id = p.id
       WHERE pc.category_id = ?1 AND p.is_published = 1 ORDER BY p.name LIMIT 30`).bind(cid).all()).results;
  },
};

// ───────────────────────── core: variants, prices, stock ─────────────────────────
const available = (v) => Math.max(0, v.stock_on_hand - v.stock_reserved);
const isBuyable = (v) => v.is_active === 1 && v.is_sellable === 1 && available(v) > 0;
const weightOf = (v) => { try { return JSON.parse(v.attributes).weight_kg ?? null; } catch { return null; } };

const Variants = {
  async get(env, id) { return env.DB.prepare('SELECT * FROM product_variants WHERE id = ?1').bind(id).first(); },
  validatePrice(raw) { return parseIntIn(raw, { min: 1, max: 10_000_000_000, label: 'قیمت' }); },
  validateSku(raw) {
    const s = String(raw ?? '').trim();
    if (!/^[A-Za-z0-9._-]{1,40}$/.test(s)) throw new UserError('کد کالا فقط می‌تواند حروف انگلیسی، عدد و . _ - باشد (حداکثر ۴۰ کاراکتر).');
    return s;
  },
  parseWeight(raw) {
    return isSkip(raw) ? null : parseDecimalIn(raw, { min: 0.001, max: 1000, label: 'وزن (کیلوگرم)' });
  },
  async create(env, actor, d) {
    for (const p of ['catalog.manage', 'price.manage', 'stock.manage']) await requirePerm(env, actor, p);
    if (!(await Products.get(env, d.pid))) throw new UserError('محصول پیدا نشد.');
    const count = (await env.DB.prepare('SELECT COUNT(*) AS c FROM product_variants WHERE product_id = ?1').bind(d.pid).first()).c;
    if (count >= MAX_VARIANTS_PER_PRODUCT) throw new UserError(`حداکثر ${fmt(MAX_VARIANTS_PER_PRODUCT)} بسته‌بندی برای هر محصول مجاز است.`);
    const attrs = JSON.stringify(d.weight != null ? { weight_kg: d.weight } : {});
    try {
      await env.DB.batch([
        env.DB.prepare('INSERT INTO product_variants (product_id, sku, label, price, stock_on_hand, attributes) VALUES (?1, ?2, ?3, ?4, ?5, ?6)')
          .bind(d.pid, d.sku, d.label, d.price, d.stock, attrs),
        env.DB.prepare(`INSERT INTO inventory_movements (variant_id, delta_on_hand, reason, note, actor_telegram_id)
                        SELECT id, ?2, 'restock', 'موجودی اولیه', ?3 FROM product_variants WHERE sku = ?1`).bind(d.sku, d.stock, actor),
      ]);
    } catch (err) {
      if (uniqueViolation(err)) throw new UserError('این کد کالا قبلاً برای بسته‌بندی دیگری استفاده شده است.');
      throw err;
    }
    const row = await env.DB.prepare('SELECT id FROM product_variants WHERE sku = ?1').bind(d.sku).first();
    await audit(env, actor, 'variant.create', row.id, d.sku);
    return row.id;
  },
  async rename(env, actor, id, raw) {
    await requirePerm(env, actor, 'catalog.manage');
    const label = cleanText(raw, { max: 60, label: 'نام بسته‌بندی' });
    const r = await env.DB.prepare('UPDATE product_variants SET label = ?1 WHERE id = ?2').bind(label, id).run();
    if (!r.meta?.changes) throw new UserError('بسته‌بندی پیدا نشد.');
    await audit(env, actor, 'variant.rename', id, label);
  },
  async toggleActive(env, actor, id) {
    await requirePerm(env, actor, 'catalog.manage');
    const r = await env.DB.prepare('UPDATE product_variants SET is_active = 1 - is_active WHERE id = ?1').bind(id).run();
    if (!r.meta?.changes) throw new UserError('بسته‌بندی پیدا نشد.');
    await audit(env, actor, 'variant.active.toggle', id, null);
  },
  async toggleSellable(env, actor, id) {
    await requirePerm(env, actor, 'stock.manage');
    const r = await env.DB.prepare('UPDATE product_variants SET is_sellable = 1 - is_sellable WHERE id = ?1').bind(id).run();
    if (!r.meta?.changes) throw new UserError('بسته‌بندی پیدا نشد.');
    await audit(env, actor, 'variant.sellable.toggle', id, null);
  },
  async setPrice(env, actor, id, raw) {
    await requirePerm(env, actor, 'price.manage');
    const price = Variants.validatePrice(raw);
    const v = await Variants.get(env, id);
    if (!v) throw new UserError('بسته‌بندی پیدا نشد.');
    if (v.price === price) throw new UserError('قیمت جدید با قیمت فعلی یکی است.');
    await env.DB.batch([
      env.DB.prepare('INSERT INTO price_change_logs (variant_id, old_price, new_price, actor_telegram_id) VALUES (?1, ?2, ?3, ?4)').bind(id, v.price, price, actor),
      env.DB.prepare('UPDATE product_variants SET price = ?1 WHERE id = ?2').bind(price, id),
    ]);
    return { old: v.price, price };
  },
  async adjustStock(env, actor, id, mode, qty, reasonRaw) {
    await requirePerm(env, actor, 'stock.manage');
    const reason = cleanText(reasonRaw, { min: 2, max: 100, label: 'دلیل' });
    const v = await Variants.get(env, id);
    if (!v) throw new UserError('بسته‌بندی پیدا نشد.');
    const delta = mode === 'add' ? qty : mode === 'sub' ? -qty : qty - v.stock_on_hand;
    if (delta === 0) throw new UserError('مقدار جدید با موجودی فعلی یکی است.');
    try {
      await env.DB.batch([
        env.DB.prepare('UPDATE product_variants SET stock_on_hand = stock_on_hand + ?1 WHERE id = ?2').bind(delta, id),
        env.DB.prepare(`INSERT INTO inventory_movements (variant_id, delta_on_hand, reason, note, actor_telegram_id) VALUES (?1, ?2, 'adjust', ?3, ?4)`).bind(id, delta, reason, actor),
      ]);
    } catch (err) {
      if (constraintViolation(err)) throw new UserError('موجودی نمی‌تواند منفی یا کمتر از مقدار رزروشده شود.');
      throw err;
    }
    return { delta, after: v.stock_on_hand + delta };
  },
  async history(env, id) {
    const moves = (await env.DB.prepare('SELECT delta_on_hand, reason, note, created_at FROM inventory_movements WHERE variant_id = ?1 ORDER BY id DESC LIMIT 5').bind(id).all()).results;
    const prices = (await env.DB.prepare('SELECT old_price, new_price, created_at FROM price_change_logs WHERE variant_id = ?1 ORDER BY id DESC LIMIT 5').bind(id).all()).results;
    return { moves, prices };
  },
};

const BulkPrice = {
  roundStep: 100,
  async preview(env, actor, scope, pct) {
    await requirePerm(env, actor, 'price.manage');
    let rows;
    if (scope === 0) {
      rows = (await env.DB.prepare(
        `SELECT v.id, v.price, v.label, p.name FROM product_variants v JOIN products p ON p.id = v.product_id ORDER BY v.id LIMIT ?1`).bind(MAX_BULK_ITEMS + 1).all()).results;
    } else {
      if (!(await Categories.get(env, scope))) throw new UserError('دسته پیدا نشد.');
      rows = (await env.DB.prepare(
        `WITH RECURSIVE tree(id) AS (SELECT ?1 UNION ALL SELECT c.id FROM categories c JOIN tree t ON c.parent_id = t.id)
         SELECT DISTINCT v.id, v.price, v.label, p.name FROM product_variants v
         JOIN products p ON p.id = v.product_id JOIN product_categories pc ON pc.product_id = p.id
         WHERE pc.category_id IN (SELECT id FROM tree) ORDER BY v.id LIMIT ?2`).bind(scope, MAX_BULK_ITEMS + 1).all()).results;
    }
    if (rows.length > MAX_BULK_ITEMS) throw new UserError(`تعداد بسته‌بندی‌ها بیشتر از ${fmt(MAX_BULK_ITEMS)} است. یک دسته‌ی کوچک‌تر انتخاب کنید.`);
    const items = rows.map((r) => {
      const raw = Math.round((r.price * (1 + pct / 100)) / BulkPrice.roundStep) * BulkPrice.roundStep;
      return { id: r.id, name: r.name, label: r.label, old: r.price, next: raw >= BulkPrice.roundStep ? raw : r.price };
    }).filter((i) => i.next !== i.old);
    if (!items.length) throw new UserError('هیچ قیمتی با این درصد تغییر نمی‌کند (یا بسته‌ای در این بخش نیست).');
    return items;
  },
  async apply(env, actor, items, batchId) {
    await requirePerm(env, actor, 'price.manage');
    const stmts = [];
    for (const i of items) {
      stmts.push(env.DB.prepare(
        `INSERT INTO price_change_logs (variant_id, old_price, new_price, batch_id, actor_telegram_id)
         SELECT id, price, ?1, ?2, ?3 FROM product_variants WHERE id = ?4 AND price = ?5`).bind(i.next, batchId, actor, i.id, i.old));
      stmts.push(env.DB.prepare('UPDATE product_variants SET price = ?1 WHERE id = ?2 AND price = ?3').bind(i.next, i.id, i.old));
    }
    const results = await env.DB.batch(stmts);
    let applied = 0;
    for (let k = 1; k < results.length; k += 2) if (results[k].meta?.changes === 1) applied++;
    await audit(env, actor, 'price.bulk', batchId, `${applied}/${items.length}`);
    return applied;
  },
};

// ───────────────────────── views (Telegram rendering) ─────────────────────────
const btn = (text, data) => ({ text, callback_data: data });
const statusIcon = (c) => (c.is_active ? '✅' : '⛔');
const onOff = (b, a, c) => (b ? a : c);

function customerHome(env, isStaff) {
  const rows = [[btn('🛍 دسته‌بندی محصولات', 'c:l:0')]];
  if (isStaff) rows.push([btn('⚙️ پنل مدیریت', 'adm:menu')]);
  return { text: 'به فروشگاه رنگ خوش آمدید. یکی از گزینه‌ها را انتخاب کنید:', keyboard: rows };
}

async function customerCategoryView(env, parentId) {
  const parent = parentId ? await Categories.get(env, parentId) : null;
  if (parentId && (!parent || !parent.is_active)) return { text: 'این دسته در دسترس نیست.', keyboard: [[btn('🔙 دسته‌ها', 'c:l:0')]] };
  const kids = await Categories.children(env, parentId || null, { onlyActive: true });
  const prods = parentId ? await Products.publishedInCategory(env, parentId) : [];
  const rows = kids.map((c) => [btn(c.name, `c:l:${c.id}`)]);
  for (const p of prods) rows.push([btn(`🎨 ${p.name}`, `c:p:${p.id}:${parentId}`)]);
  rows.push([btn(parent ? '🔙 بازگشت' : '🏠 منوی اصلی', parent ? `c:l:${parent.parent_id ?? 0}` : 'c:home')]);
  let text;
  if (!kids.length && !prods.length) text = parent ? `دسته: ${parent.name}\nهنوز محصولی در این دسته ثبت نشده است.` : 'هنوز دسته‌ای ثبت نشده است.';
  else text = parent ? `دسته: ${parent.name}` : 'دسته‌بندی محصولات:';
  return { text, keyboard: rows };
}

async function customerProductView(env, pid, cid) {
  const p = await Products.get(env, pid);
  const back = [[btn('🔙 بازگشت', `c:l:${cid || 0}`)]];
  if (!p || !p.is_published) return { text: 'این محصول در دسترس نیست.', keyboard: back };
  const cur = await currencyLabel(env);
  const specs = Object.entries(Products.specs(p));
  const vars = await Products.variants(env, pid, { onlyActive: true });
  const lines = [`🎨 ${p.name}`];
  if (p.brand) lines.push(`برند: ${p.brand}`);
  if (p.description) lines.push('', p.description);
  if (specs.length) lines.push('', 'مشخصات:', ...specs.map(([k, v]) => `• ${k}: ${v}`));
  lines.push('', 'بسته‌بندی‌ها:');
  if (!vars.length) lines.push('هنوز بسته‌بندی‌ای ثبت نشده است.');
  for (const v of vars) {
    const w = weightOf(v);
    lines.push(`• ${v.label}${w ? ` (وزن: ${fmt(w)} کیلوگرم)` : ''} — ${fmt(v.price)} ${cur} — ${isBuyable(v) ? '✅ موجود' : '❌ ناموجود'}`);
  }
  return { text: clip(lines.join('\n')), keyboard: back };
}

async function adminMenuView(env, userId) {
  const access = await getAccess(env, userId);
  if (!access) throw new UserError('شما دسترسی مدیریتی ندارید.');
  const rows = [];
  if (access.has('catalog.manage')) rows.push([btn('📂 دسته‌بندی‌ها', 'cat:l:0')]);
  if (BROWSE_PERMS.some((p) => access.has(p))) rows.push([btn('🛒 محصولات و قیمت و موجودی', 'prd:l:0')]);
  if (access.has('price.manage')) rows.push([btn('💲 تغییر درصدی قیمت‌ها', 'bp:menu')]);
  if (access.role === 'owner') rows.push([btn('👥 مدیریت ادمین‌ها', 'adm:list')]);
  const empty = rows.length === 0;
  rows.push([btn('🏠 منوی اصلی', 'c:home')]);
  return { text: empty ? 'پنل مدیریت:\nفعلاً بخشی برای نقش شما فعال نیست.' : 'پنل مدیریت:', keyboard: rows };
}

// ── admin management views
async function adminListView(env, userId) {
  requireOwner(env, userId);
  const list = await Admins.list(env);
  const rows = list.map((a) => [btn(`${a.is_active ? '✅' : '⛔'} ${a.role === 'admin' ? 'ادمین' : 'اپراتور'} — ${personLabel(a)}`, `adm:v:${a.telegram_id}`)]);
  rows.push([btn('➕ افزودن ادمین', 'adm:add')]);
  rows.push([btn('🔙 بازگشت', 'adm:menu')]);
  return { text: list.length ? 'ادمین‌ها (مالک اصلی جداگانه است و همیشه دسترسی کامل دارد):' : 'هنوز ادمینی ثبت نشده است. مالک اصلی دسترسی کامل دارد.', keyboard: rows };
}
async function adminAddView(env, userId) {
  requireOwner(env, userId);
  const users = await Admins.recentUsers(env);
  const rows = users.map((u) => [btn(personLabel(u), `adm:pick:${u.telegram_id}`)]);
  rows.push([btn('🔢 وارد کردن شناسه‌ی عددی', 'adm:id')]);
  rows.push([btn('🔙 بازگشت', 'adm:list')]);
  return {
    text: users.length ? 'از بین افرادی که ربات را استارت کرده‌اند، یکی را انتخاب کنید.\n(اگر فرد در لیست نیست، از او بخواهید ربات را /start کند.)'
      : 'هنوز فرد دیگری ربات را استارت نکرده است. از او بخواهید ربات را /start کند، یا شناسه‌ی عددی‌اش را وارد کنید.',
    keyboard: rows,
  };
}
async function adminRoleChoiceView(env, userId, tgid) {
  requireOwner(env, userId);
  Admins.validateId(tgid);
  if (isOwner(env, tgid)) throw new UserError('مالک اصلی نیازی به ثبت به‌عنوان ادمین ندارد.');
  const u = (await env.DB.prepare('SELECT telegram_id, first_name, username FROM users WHERE telegram_id = ?1').bind(tgid).first()) ?? { telegram_id: tgid };
  return {
    text: `نقش «${personLabel(u)}» را انتخاب کنید:\n\n• ادمین: مدیریت دسته‌بندی، محصول، قیمت، موجودی، سفارش‌ها\n• اپراتور: فقط پردازش سفارش‌ها`,
    keyboard: [[btn('ادمین', `adm:set:${tgid}:admin`), btn('اپراتور', `adm:set:${tgid}:operator`)], [btn('🔙 بازگشت', 'adm:add')]],
  };
}
async function adminDetailView(env, userId, tgid) {
  requireOwner(env, userId);
  const a = await Admins.get(env, tgid);
  if (!a) throw new UserError('این ادمین پیدا نشد.');
  const other = a.role === 'admin' ? 'operator' : 'admin';
  return {
    text: `${personLabel(a)}\nنقش: ${a.role === 'admin' ? 'ادمین' : 'اپراتور'}\nوضعیت: ${a.is_active ? 'فعال' : 'غیرفعال'}`,
    keyboard: [
      [btn(a.is_active ? '⛔ غیرفعال کن' : '✅ فعال کن', `adm:tg:${tgid}`)],
      [btn(`تغییر نقش به ${other === 'admin' ? 'ادمین' : 'اپراتور'}`, `adm:set:${tgid}:${other}`)],
      [btn('🔙 بازگشت', 'adm:list')],
    ],
  };
}

// ── category views (admin)
async function adminCategoryList(env, userId, parentId) {
  await requirePerm(env, userId, 'catalog.manage');
  const parent = parentId ? await Categories.get(env, parentId) : null;
  const kids = await Categories.children(env, parentId || null);
  const rows = kids.map((c) => [btn(`${statusIcon(c)} ${c.name}`, `cat:v:${c.id}`)]);
  rows.push([btn('➕ دسته جدید', `cat:n:${parentId || 0}`)]);
  rows.push([btn('🔙 بازگشت', parent ? (parent.parent_id ? `cat:l:${parent.parent_id}` : 'cat:l:0') : 'adm:menu')]);
  const title = parent ? `زیرمجموعه‌های «${parent.name}»` : 'دسته‌بندی‌ها';
  return { text: kids.length ? `${title}:\n(✅ فعال، ⛔ غیرفعال)` : `${title}: هنوز چیزی ثبت نشده است.`, keyboard: rows };
}
async function adminCategoryDetail(env, userId, id) {
  await requirePerm(env, userId, 'catalog.manage');
  const c = await Categories.get(env, id);
  if (!c) throw new UserError('دسته پیدا نشد.');
  const kids = await Categories.children(env, id);
  return {
    text: `دسته: ${c.name}\nوضعیت: ${c.is_active ? 'فعال (برای مشتری نمایش داده می‌شود)' : 'غیرفعال (برای مشتری مخفی است)'}\nتعداد زیرمجموعه: ${kids.length}`,
    keyboard: [
      [btn('✏️ ویرایش نام', `cat:r:${id}`), btn(c.is_active ? '⛔ غیرفعال کن' : '✅ فعال کن', `cat:t:${id}`)],
      [btn('⬆️ بالا', `cat:u:${id}`), btn('⬇️ پایین', `cat:d:${id}`)],
      [btn('📂 زیرمجموعه‌ها', `cat:l:${id}`)],
      [btn('🔙 بازگشت', `cat:l:${c.parent_id ?? 0}`)],
    ],
  };
}

// ── product views (admin)
async function adminProductList(env, userId, page) {
  await requireAnyPerm(env, userId, BROWSE_PERMS);
  const access = await getAccess(env, userId);
  const { total, rows } = await Products.page(env, page);
  const kb = rows.map((p) => [btn(`${p.is_published ? '✅' : '📝'} ${p.name}`, `prd:v:${p.id}`)]);
  const nav = [];
  if (page > 0) nav.push(btn('⬅️ قبلی', `prd:l:${page - 1}`));
  if ((page + 1) * PAGE_SIZE < total) nav.push(btn('بعدی ➡️', `prd:l:${page + 1}`));
  if (nav.length) kb.push(nav);
  if (access.has('catalog.manage')) kb.push([btn('➕ محصول جدید', 'prd:n')]);
  kb.push([btn('🔙 بازگشت', 'adm:menu')]);
  return { text: total ? `محصولات (${fmt(total)}):\n(✅ منتشرشده، 📝 پیش‌نویس)` : 'هنوز محصولی ثبت نشده است.', keyboard: kb };
}
async function adminProductDetail(env, userId, pid) {
  const access = await requireAnyPerm(env, userId, BROWSE_PERMS);
  const p = await Products.get(env, pid);
  if (!p) throw new UserError('محصول پیدا نشد.');
  const cur = await currencyLabel(env);
  const cats = await Products.categories(env, pid);
  const vars = await Products.variants(env, pid);
  const specs = Object.entries(Products.specs(p));
  const lines = [`📦 ${p.name}`, `برند: ${p.brand ?? '—'}`, `وضعیت: ${p.is_published ? 'منتشرشده (برای مشتری نمایش داده می‌شود)' : 'پیش‌نویس (برای مشتری مخفی است)'}`,
    `دسته‌ها: ${cats.length ? cats.map((c) => c.name).join('، ') : '—'}`, `توضیحات: ${p.description ?? '—'}`, '', 'مشخصات:'];
  lines.push(...(specs.length ? specs.map(([k, v]) => `• ${k}: ${v}`) : ['—']));
  lines.push('', 'بسته‌بندی‌ها:');
  if (!vars.length) lines.push('—');
  for (const v of vars) {
    lines.push(`• ${v.label} | کد ${v.sku} | ${fmt(v.price)} ${cur} | موجودی ${fmt(v.stock_on_hand)} (رزرو ${fmt(v.stock_reserved)}) ${v.is_active ? '' : '| ⛔ غیرفعال '}${v.is_sellable ? '' : '| 🚫 ناموجود موقت'}`);
  }
  const kb = vars.map((v) => [btn(`${v.is_active ? '📦' : '⛔'} ${v.label}`, `var:v:${v.id}`)]);
  if (access.has('catalog.manage')) {
    kb.push([btn('✏️ نام', `prd:e:${pid}:name`), btn('✏️ برند', `prd:e:${pid}:brand`), btn('✏️ توضیحات', `prd:e:${pid}:description`)]);
    kb.push([btn('➕ مشخصه', `prd:s:${pid}`), btn('🧹 پاک کردن مشخصات', `prd:sc:${pid}`)]);
    kb.push([btn('📂 دسته‌های محصول', `prd:c:${pid}`)]);
    kb.push([btn(p.is_published ? '📝 برگردان به پیش‌نویس' : '✅ انتشار', `prd:p:${pid}`)]);
  }
  if (['catalog.manage', 'price.manage', 'stock.manage'].every((x) => access.has(x))) kb.push([btn('➕ بسته‌بندی جدید', `prd:vn:${pid}`)]);
  kb.push([btn('🔙 بازگشت', 'prd:l:0')]);
  return { text: clip(lines.join('\n')), keyboard: kb };
}
async function adminProductCategories(env, userId, pid) {
  await requirePerm(env, userId, 'catalog.manage');
  const p = await Products.get(env, pid);
  if (!p) throw new UserError('محصول پیدا نشد.');
  const linked = new Set((await Products.categories(env, pid)).map((c) => c.id));
  const all = (await env.DB.prepare('SELECT id, name, parent_id FROM categories ORDER BY parent_id IS NOT NULL, parent_id, sort_order, id LIMIT 40').all()).results;
  const kb = all.map((c) => [btn(`${linked.has(c.id) ? '☑️' : '⬜'} ${c.parent_id ? '↳ ' : ''}${c.name}`, `prd:ct:${pid}:${c.id}`)]);
  kb.push([btn('🔙 بازگشت', `prd:v:${pid}`)]);
  return { text: all.length ? `دسته‌های «${p.name}» را انتخاب کنید (لمس = افزودن/حذف):` : 'ابتدا از «دسته‌بندی‌ها» یک دسته بسازید.', keyboard: kb };
}
async function adminVariantDetail(env, userId, vid) {
  const access = await requireAnyPerm(env, userId, BROWSE_PERMS);
  const v = await Variants.get(env, vid);
  if (!v) throw new UserError('بسته‌بندی پیدا نشد.');
  const p = await Products.get(env, v.product_id);
  const cur = await currencyLabel(env);
  const w = weightOf(v);
  const text = [`📦 ${p.name} — ${v.label}`, `کد کالا: ${v.sku}`, `قیمت: ${fmt(v.price)} ${cur}`, `موجودی فیزیکی: ${fmt(v.stock_on_hand)}`,
    `رزرو شده: ${fmt(v.stock_reserved)}`, `قابل فروش: ${fmt(available(v))}`, `وضعیت فروش: ${v.is_sellable ? 'فعال' : '🚫 موقتاً ناموجود'}`,
    `وضعیت: ${v.is_active ? 'فعال' : '⛔ غیرفعال (برای مشتری مخفی)'}`, `وزن: ${w ? fmt(w) + ' کیلوگرم' : '—'}`].join('\n');
  const kb = [];
  if (access.has('price.manage')) kb.push([btn('💲 تغییر قیمت', `var:pr:${vid}`)]);
  if (access.has('stock.manage')) {
    kb.push([btn('➕ افزایش موجودی', `var:st:${vid}:add`), btn('➖ کاهش', `var:st:${vid}:sub`)]);
    kb.push([btn('🔢 تنظیم مقدار موجودی', `var:st:${vid}:set`), btn(v.is_sellable ? '🚫 ناموجود موقت' : '✅ فروش مجدد', `var:sl:${vid}`)]);
  }
  if (access.has('catalog.manage')) kb.push([btn('✏️ نام بسته‌بندی', `var:rn:${vid}`), btn(v.is_active ? '⛔ غیرفعال کن' : '✅ فعال کن', `var:ac:${vid}`)]);
  kb.push([btn('🧾 سابقه قیمت و موجودی', `var:h:${vid}`)]);
  kb.push([btn('🔙 بازگشت', `prd:v:${v.product_id}`)]);
  return { text, keyboard: kb };
}
async function adminVariantHistory(env, userId, vid) {
  await requireAnyPerm(env, userId, BROWSE_PERMS);
  const v = await Variants.get(env, vid);
  if (!v) throw new UserError('بسته‌بندی پیدا نشد.');
  const h = await Variants.history(env, vid);
  const lines = [`🧾 سابقه «${v.label}»`, '', 'آخرین تغییرات موجودی:'];
  lines.push(...(h.moves.length ? h.moves.map((m) => `• ${m.delta_on_hand > 0 ? '+' : ''}${fmt(m.delta_on_hand)} — ${m.note ?? m.reason} (${m.created_at})`) : ['—']));
  lines.push('', 'آخرین تغییرات قیمت:');
  lines.push(...(h.prices.length ? h.prices.map((x) => `• ${fmt(x.old_price)} ← ${fmt(x.new_price)} (${x.created_at})`) : ['—']));
  return { text: lines.join('\n'), keyboard: [[btn('🔙 بازگشت', `var:v:${vid}`)]] };
}
async function bulkMenuView(env, userId) {
  await requirePerm(env, userId, 'price.manage');
  const cats = (await env.DB.prepare('SELECT id, name, parent_id FROM categories ORDER BY parent_id IS NOT NULL, parent_id, sort_order, id LIMIT 40').all()).results;
  const kb = [[btn('🌐 همه‌ی محصولات', 'bp:s:0')]];
  for (const c of cats) kb.push([btn(`${c.parent_id ? '↳ ' : ''}${c.name}`, `bp:s:${c.id}`)]);
  kb.push([btn('🔙 بازگشت', 'adm:menu')]);
  return { text: `تغییر درصدی قیمت: ابتدا محدوده را انتخاب کنید.\n(برای یک دسته، زیرمجموعه‌هایش هم شامل می‌شوند. حداکثر ${fmt(MAX_BULK_ITEMS)} بسته‌بندی در هر عملیات.)`, keyboard: kb };
}
async function bulkPreviewView(env, items, pct) {
  const cur = await currencyLabel(env);
  const sample = items.slice(0, 8).map((i) => `• ${i.name} — ${i.label}: ${fmt(i.old)} ← ${fmt(i.next)}`);
  const more = items.length > sample.length ? [`… و ${fmt(items.length - sample.length)} مورد دیگر`] : [];
  return {
    text: clip([`پیش‌نمایش تغییر ${pct > 0 ? '+' : ''}${fmt(pct)}٪ (گرد شده به ${fmt(BulkPrice.roundStep)} ${cur})`, `تعداد بسته‌بندی‌های تغییرکننده: ${fmt(items.length)}`, '', ...sample, ...more, '', 'تأیید می‌کنید؟'].join('\n')),
    keyboard: [[btn('✅ تأیید و اعمال', 'bp:ok'), btn('❌ انصراف', 'bp:no')]],
  };
}
// ───────────────────────── Telegram plumbing ─────────────────────────
const CANCEL_HINT = '\n(برای لغو: /cancel)';

async function showView(env, chatId, messageId, view) {
  const reply_markup = { inline_keyboard: view.keyboard };
  if (messageId) {
    const r = await tg(env, 'editMessageText', { chat_id: chatId, message_id: messageId, text: view.text, reply_markup });
    if (r.ok || /not modified/i.test(r.description ?? '')) return;
  }
  await tg(env, 'sendMessage', { chat_id: chatId, text: view.text, reply_markup });
}

async function say(env, chatId, text) {
  await tg(env, 'sendMessage', { chat_id: chatId, text });
}

async function upsertUser(env, from) {
  await env.DB.prepare(
    `INSERT INTO users (telegram_id, first_name, username) VALUES (?1, ?2, ?3)
     ON CONFLICT(telegram_id) DO UPDATE SET first_name = ?2, username = ?3`
  ).bind(from.id, from.first_name ?? null, from.username ?? null).run();
}

// ── typed answers for multi-step flows
async function handleState(env, userId, chatId, state, text) {
  const p = state.payload;
  const done = () => State.clear(env, userId);
  switch (state.action) {
    case 'cat_new': {
      const id = await Categories.create(env, userId, { parentId: p.parentId || null, name: text });
      await done(); return showView(env, chatId, null, await adminCategoryDetail(env, userId, id));
    }
    case 'cat_rename': {
      await Categories.rename(env, userId, p.id, text);
      await done(); return showView(env, chatId, null, await adminCategoryDetail(env, userId, p.id));
    }
    case 'adm_add_id': {
      const id = parseIntIn(text, { min: 1, max: 999_999_999_999_999, label: 'شناسه‌ی تلگرام' });
      const view = await adminRoleChoiceView(env, userId, id);
      await done(); return showView(env, chatId, null, view);
    }
    case 'prd_new': {
      const id = await Products.create(env, userId, text);
      await done(); return showView(env, chatId, null, await adminProductDetail(env, userId, id));
    }
    case 'prd_edit': {
      await Products.update(env, userId, p.id, p.field, text);
      await done(); return showView(env, chatId, null, await adminProductDetail(env, userId, p.id));
    }
    case 'prd_spec': {
      await Products.addSpec(env, userId, p.id, text);
      await done(); return showView(env, chatId, null, await adminProductDetail(env, userId, p.id));
    }
    case 'var_new': {
      const cur = await currencyLabel(env);
      if (p.step === 'label') {
        const label = cleanText(text, { max: 60, label: 'نام بسته‌بندی' });
        await State.set(env, userId, 'var_new', { ...p, step: 'sku', label });
        return say(env, chatId, 'کد کالا (SKU) را بفرستید: فقط حروف انگلیسی، عدد و - _ . (مثلاً AC-4L)' + CANCEL_HINT);
      }
      if (p.step === 'sku') {
        const sku = Variants.validateSku(text);
        if (await env.DB.prepare('SELECT 1 AS x FROM product_variants WHERE sku = ?1').bind(sku).first()) throw new UserError('این کد کالا قبلاً استفاده شده است.');
        await State.set(env, userId, 'var_new', { ...p, step: 'price', sku });
        return say(env, chatId, `قیمت را به ${cur} بفرستید (فقط عدد):` + CANCEL_HINT);
      }
      if (p.step === 'price') {
        const price = Variants.validatePrice(text);
        await State.set(env, userId, 'var_new', { ...p, step: 'stock', price });
        return say(env, chatId, 'موجودی اولیه را بفرستید (عدد؛ صفر هم مجاز است):' + CANCEL_HINT);
      }
      if (p.step === 'stock') {
        const stock = parseIntIn(text, { min: 0, max: 1_000_000, label: 'موجودی' });
        await State.set(env, userId, 'var_new', { ...p, step: 'weight', stock });
        return say(env, chatId, 'وزن را به کیلوگرم بفرستید (مثلاً 4.5) یا برای رد کردن «-» بفرستید:' + CANCEL_HINT);
      }
      if (p.step === 'weight') {
        const weight = Variants.parseWeight(text);
        const id = await Variants.create(env, userId, { pid: p.pid, label: p.label, sku: p.sku, price: p.price, stock: p.stock, weight });
        await done(); return showView(env, chatId, null, await adminVariantDetail(env, userId, id));
      }
      return done();
    }
    case 'var_price': {
      const r = await Variants.setPrice(env, userId, p.id, text);
      await done();
      const cur = await currencyLabel(env);
      await say(env, chatId, `✅ قیمت از ${fmt(r.old)} به ${fmt(r.price)} ${cur} تغییر کرد.`);
      return showView(env, chatId, null, await adminVariantDetail(env, userId, p.id));
    }
    case 'var_rename': {
      await Variants.rename(env, userId, p.id, text);
      await done(); return showView(env, chatId, null, await adminVariantDetail(env, userId, p.id));
    }
    case 'stock_qty': {
      const qty = parseIntIn(text, { min: p.mode === 'set' ? 0 : 1, max: 1_000_000, label: 'تعداد' });
      await State.set(env, userId, 'stock_reason', { ...p, qty });
      return say(env, chatId, 'دلیل تغییر موجودی را بنویسید (مثلاً «ورود محموله» یا «شمارش انبار»):' + CANCEL_HINT);
    }
    case 'stock_reason': {
      const r = await Variants.adjustStock(env, userId, p.vid, p.mode, p.qty, text);
      await done();
      await say(env, chatId, `✅ موجودی تغییر کرد (${r.delta > 0 ? '+' : ''}${fmt(r.delta)}). موجودی جدید: ${fmt(r.after)}`);
      return showView(env, chatId, null, await adminVariantDetail(env, userId, p.vid));
    }
    case 'bp_pct': {
      const pct = parseDecimalIn(text, { min: -90, max: 300, label: 'درصد' });
      if (pct === 0) throw new UserError('درصد نمی‌تواند صفر باشد.');
      const items = await BulkPrice.preview(env, userId, p.scope, pct);
      await State.set(env, userId, 'bp_confirm', { scope: p.scope, pct, items });
      return showView(env, chatId, null, await bulkPreviewView(env, items, pct));
    }
    default:
      return; // e.g. bp_confirm waits for the confirm button, not for text
  }
}

async function handleMessage(env, msg) {
  if (!msg.from || msg.chat?.type !== 'private') return;
  const userId = msg.from.id, chatId = msg.chat.id;
  await upsertUser(env, msg.from);
  const text = (msg.text ?? '').trim();

  try {
    if (text === '/start' || text.startsWith('/start ')) {
      await State.clear(env, userId);
      const staff = !!(await getAccess(env, userId));
      const view = customerHome(env, staff);
      await showView(env, chatId, null, { ...view, text: `سلام ${msg.from.first_name ?? ''} 👋\n${view.text}` });
      return;
    }
    if (text === '/admin') {
      await showView(env, chatId, null, await adminMenuView(env, userId));
      return;
    }
    if (text === '/cancel') {
      await State.clear(env, userId);
      await say(env, chatId, 'عملیات لغو شد.');
      return;
    }
    const state = await State.get(env, userId);
    if (!state || text.startsWith('/')) return;
    await handleState(env, userId, chatId, state, text);
  } catch (err) {
    if (err instanceof UserError) { await say(env, chatId, `⚠️ ${err.message}`); return; }
    throw err;
  }
}

async function handleCallback(env, cq) {
  const chat = cq.message?.chat, messageId = cq.message?.message_id;
  const userId = cq.from?.id;
  const answer = (text) => tg(env, 'answerCallbackQuery', { callback_query_id: cq.id, ...(text ? { text, show_alert: true } : {}) });
  if (!chat || chat.type !== 'private' || !userId || typeof cq.data !== 'string' || cq.data.length > 64) return answer();

  const [ns, action, a, b] = cq.data.split(':');
  const n = Number(a);
  const idOk = a !== undefined && a !== '' && Number.isInteger(n) && n >= 0;
  const ask = async (stateAction, payload, prompt) => {
    await State.set(env, userId, stateAction, payload);
    await answer();
    await say(env, chat.id, prompt + CANCEL_HINT);
  };

  try {
    let view = null;
    if (ns === 'c') {
      if (action === 'home') view = customerHome(env, !!(await getAccess(env, userId)));
      else if (action === 'l' && idOk) view = await customerCategoryView(env, n);
      else if (action === 'p' && idOk) view = await customerProductView(env, n, Number(b) || 0);
    } else if (ns === 'adm') {
      if (action === 'menu') view = await adminMenuView(env, userId);
      else if (action === 'list') view = await adminListView(env, userId);
      else if (action === 'add') view = await adminAddView(env, userId);
      else if (action === 'id') {
        requireOwner(env, userId);
        return ask('adm_add_id', {}, 'شناسه‌ی عددی تلگرام فرد را بفرستید (او می‌تواند آن را از ربات @userinfobot بگیرد).');
      } else if (idOk && n > 0) {
        if (action === 'pick') view = await adminRoleChoiceView(env, userId, n);
        else if (action === 'v') view = await adminDetailView(env, userId, n);
        else if (action === 'set') {
          await Admins.upsert(env, userId, n, b);
          try { await say(env, n, 'شما توسط مالک فروشگاه به‌عنوان مدیر ربات اضافه شدید. برای ورود به پنل بفرستید: /admin'); } catch { /* user may not have started the bot */ }
          view = await adminDetailView(env, userId, n);
        } else if (action === 'tg') {
          requireOwner(env, userId);
          const adm = await Admins.get(env, n);
          if (!adm) throw new UserError('این ادمین پیدا نشد.');
          await Admins.setActive(env, userId, n, !adm.is_active);
          view = await adminDetailView(env, userId, n);
        }
      }
    } else if (ns === 'cat' && idOk) {
      await requirePerm(env, userId, 'catalog.manage');
      if (action === 'l') view = await adminCategoryList(env, userId, n);
      else if (action === 'v') view = await adminCategoryDetail(env, userId, n);
      else if (action === 't') { await Categories.toggle(env, userId, n); view = await adminCategoryDetail(env, userId, n); }
      else if (action === 'u' || action === 'd') { await Categories.move(env, userId, n, action === 'u' ? 'up' : 'down'); view = await adminCategoryDetail(env, userId, n); }
      else if (action === 'n') return ask('cat_new', { parentId: n }, 'نام دسته‌ی جدید را بفرستید:');
      else if (action === 'r') {
        if (!(await Categories.get(env, n))) throw new UserError('دسته پیدا نشد.');
        return ask('cat_rename', { id: n }, 'نام جدید را بفرستید:');
      }
    } else if (ns === 'prd') {
      if (action === 'l' && idOk) view = await adminProductList(env, userId, n);
      else if (action === 'n') { await requirePerm(env, userId, 'catalog.manage'); return ask('prd_new', {}, 'نام محصول جدید را بفرستید:'); }
      else if (idOk && n > 0) {
        if (action === 'v') view = await adminProductDetail(env, userId, n);
        else if (action === 'e' && ['name', 'brand', 'description'].includes(b)) {
          await requirePerm(env, userId, 'catalog.manage');
          if (!(await Products.get(env, n))) throw new UserError('محصول پیدا نشد.');
          const label = { name: 'نام جدید محصول', brand: 'برند', description: 'توضیحات' }[b];
          return ask('prd_edit', { id: n, field: b }, `${label} را بفرستید${b === 'name' ? '' : ' (یا «-» برای حذف)'}:`);
        } else if (action === 's') {
          await requirePerm(env, userId, 'catalog.manage');
          if (!(await Products.get(env, n))) throw new UserError('محصول پیدا نشد.');
          return ask('prd_spec', { id: n }, 'مشخصه را به شکل «نام: مقدار» بفرستید. مثال:\nرنگ: سفید\nنوع: اکریلیک\nسطح براقیت: مات');
        } else if (action === 'sc') { await Products.clearSpecs(env, userId, n); view = await adminProductDetail(env, userId, n); }
        else if (action === 'p') { await Products.togglePublish(env, userId, n); view = await adminProductDetail(env, userId, n); }
        else if (action === 'c') view = await adminProductCategories(env, userId, n);
        else if (action === 'ct') { await Products.toggleCategory(env, userId, n, Number(b)); view = await adminProductCategories(env, userId, n); }
        else if (action === 'vn') {
          for (const p of ['catalog.manage', 'price.manage', 'stock.manage']) await requirePerm(env, userId, p);
          if (!(await Products.get(env, n))) throw new UserError('محصول پیدا نشد.');
          return ask('var_new', { pid: n, step: 'label' }, 'نام بسته‌بندی را بفرستید (مثلاً «۴ لیتری»):');
        }
      }
    } else if (ns === 'var' && idOk && n > 0) {
      if (action === 'v') view = await adminVariantDetail(env, userId, n);
      else if (action === 'h') view = await adminVariantHistory(env, userId, n);
      else if (action === 'pr') {
        await requirePerm(env, userId, 'price.manage');
        const v = await Variants.get(env, n);
        if (!v) throw new UserError('بسته‌بندی پیدا نشد.');
        const cur = await currencyLabel(env);
        return ask('var_price', { id: n }, `قیمت جدید را به ${cur} بفرستید (فقط عدد). قیمت فعلی: ${fmt(v.price)}`);
      } else if (action === 'st' && ['add', 'sub', 'set'].includes(b)) {
        await requirePerm(env, userId, 'stock.manage');
        if (!(await Variants.get(env, n))) throw new UserError('بسته‌بندی پیدا نشد.');
        const q = { add: 'تعداد افزایش', sub: 'تعداد کاهش', set: 'مقدار جدید کل موجودی' }[b];
        return ask('stock_qty', { vid: n, mode: b }, `${q} را بفرستید (عدد):`);
      } else if (action === 'sl') { await Variants.toggleSellable(env, userId, n); view = await adminVariantDetail(env, userId, n); }
      else if (action === 'ac') { await Variants.toggleActive(env, userId, n); view = await adminVariantDetail(env, userId, n); }
      else if (action === 'rn') {
        await requirePerm(env, userId, 'catalog.manage');
        if (!(await Variants.get(env, n))) throw new UserError('بسته‌بندی پیدا نشد.');
        return ask('var_rename', { id: n }, 'نام جدید بسته‌بندی را بفرستید:');
      }
    } else if (ns === 'bp') {
      if (action === 'menu') view = await bulkMenuView(env, userId);
      else if (action === 's' && idOk) {
        await requirePerm(env, userId, 'price.manage');
        return ask('bp_pct', { scope: n }, 'درصد تغییر را بفرستید. مثال: 5 برای افزایش ۵٪ یا -3.5 برای کاهش ۳٫۵٪');
      } else if (action === 'ok') {
        await requirePerm(env, userId, 'price.manage');
        const st = await State.get(env, userId);
        if (!st || st.action !== 'bp_confirm') throw new UserError('زمان تأیید گذشته است. دوباره از «تغییر درصدی قیمت‌ها» شروع کنید.');
        const applied = await BulkPrice.apply(env, userId, st.payload.items, `bp-${Date.now()}`);
        await State.clear(env, userId);
        const total = st.payload.items.length;
        view = {
          text: `✅ قیمت ${fmt(applied)} بسته‌بندی از ${fmt(total)} مورد تغییر کرد.` + (applied < total ? '\nقیمت بعضی موارد بین پیش‌نمایش و تأیید عوض شده بود و دست‌نخورده ماند.' : ''),
          keyboard: [[btn('🔙 پنل مدیریت', 'adm:menu')]],
        };
      } else if (action === 'no') { await State.clear(env, userId); view = await adminMenuView(env, userId); }
    }
    await answer();
    if (view) await showView(env, chat.id, messageId, view);
  } catch (err) {
    if (err instanceof UserError) { await answer(err.message); return; }
    throw err;
  }
}

// ───────────────────────── HTTP entry ─────────────────────────
async function handleWebhook(request, env) {
  if (request.method !== 'POST') return new Response('method not allowed', { status: 405 });
  const secret = request.headers.get('X-Telegram-Bot-Api-Secret-Token');
  if (!safeEqual(secret ?? '', env.WEBHOOK_SECRET ?? '#')) return new Response('forbidden', { status: 403 });

  const raw = await request.text();
  if (raw.length > MAX_BODY_BYTES) return new Response('too large', { status: 413 });
  let update;
  try { update = JSON.parse(raw); } catch { return new Response('bad request', { status: 400 }); }
  if (!Number.isSafeInteger(update?.update_id)) return new Response('bad request', { status: 400 });

  // Telegram retries on non-200: process each update_id once.
  const seen = await env.DB.prepare('INSERT OR IGNORE INTO processed_updates (update_id) VALUES (?1)')
    .bind(update.update_id).run();
  if (!seen.meta?.changes) return new Response('ok');

  try {
    if (update.message) await handleMessage(env, update.message);
    else if (update.callback_query) await handleCallback(env, update.callback_query);
  } catch (err) {
    console.error('handler error:', err?.message ?? 'unknown'); // message only, no request data
  }
  return new Response('ok');
}

async function handleSetup(url, env) {
  if (!safeEqual(url.searchParams.get('key') ?? '', env.SETUP_KEY ?? '#')) return new Response('forbidden', { status: 403 });
  const result = await tg(env, 'setWebhook', {
    url: `${url.origin}/webhook`,
    secret_token: env.WEBHOOK_SECRET,
    allowed_updates: ['message', 'callback_query'],
    drop_pending_updates: true,
  });
  return Response.json({ ok: result.ok === true, description: result.description ?? null });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    try {
      if (url.pathname === '/health') {
        await env.DB.prepare('SELECT 1').first();
        return new Response('ok');
      }
      if (url.pathname === '/webhook') return await handleWebhook(request, env);
      if (url.pathname === '/setup') return await handleSetup(url, env);
      return new Response('not found', { status: 404 });
    } catch (err) {
      console.error('unhandled error:', err?.message ?? 'unknown');
      return new Response('internal error', { status: 500 });
    }
  },
};

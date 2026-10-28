// Paint Shop Bot — Stage 3: roles, admins, categories, products, variants, prices, stock (single file, no dependencies).
// Bindings/secrets: DB (D1), BOT_TOKEN, WEBHOOK_SECRET, OWNER_TELEGRAM_ID, SETUP_KEY

const MAX_BODY_BYTES = 64 * 1024;
const STATE_TTL_MS = 30 * 60 * 1000;
const MAX_CATEGORY_DEPTH = 3;
const MAX_VARIANTS_PER_PRODUCT = 20;
const MAX_SPECS = 30;
const MAX_BULK_ITEMS = 50;
const PAGE_SIZE = 8;
const MAX_IMAGES_PER_PRODUCT = 8;

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

const ProductImages = {
  async list(env, pid) {
    return (await env.DB.prepare('SELECT id, product_id, telegram_file_id, image_key FROM product_images WHERE product_id = ?1 AND telegram_file_id IS NOT NULL ORDER BY sort_order, id').bind(pid).all()).results;
  },
  async get(env, id) { return env.DB.prepare('SELECT * FROM product_images WHERE id = ?1').bind(id).first(); },
  async add(env, actor, pid, fileId, uniqueId) {
    await requirePerm(env, actor, 'catalog.manage');
    if (!(await Products.get(env, pid))) throw new UserError('محصول پیدا نشد.');
    if (typeof fileId !== 'string' || !fileId || fileId.length > 300 || typeof uniqueId !== 'string' || !uniqueId || uniqueId.length > 100) throw new UserError('عکس نامعتبر است.');
    const key = `tg:${uniqueId}`;
    const count = (await env.DB.prepare('SELECT COUNT(*) AS c FROM product_images WHERE product_id = ?1').bind(pid).first()).c;
    if (count >= MAX_IMAGES_PER_PRODUCT) throw new UserError(`حداکثر ${fmt(MAX_IMAGES_PER_PRODUCT)} عکس برای هر محصول مجاز است.`);
    if (await env.DB.prepare('SELECT 1 AS x FROM product_images WHERE product_id = ?1 AND image_key = ?2').bind(pid, key).first()) throw new UserError('این عکس قبلاً برای این محصول اضافه شده است.');
    const max = await env.DB.prepare('SELECT COALESCE(MAX(sort_order), 0) AS m FROM product_images WHERE product_id = ?1').bind(pid).first();
    await env.DB.prepare('INSERT INTO product_images (product_id, image_key, telegram_file_id, sort_order) VALUES (?1, ?2, ?3, ?4)').bind(pid, key, fileId, max.m + 1).run();
    await audit(env, actor, 'product.image.add', pid, key);
    return count + 1;
  },
  async remove(env, actor, imageId) {
    await requirePerm(env, actor, 'catalog.manage');
    const img = await ProductImages.get(env, imageId);
    if (!img) throw new UserError('عکس پیدا نشد.');
    await env.DB.prepare('DELETE FROM product_images WHERE id = ?1').bind(imageId).run();
    await audit(env, actor, 'product.image.remove', img.product_id, String(imageId));
    return img.product_id;
  },
  async makePrimary(env, actor, imageId) {
    await requirePerm(env, actor, 'catalog.manage');
    const img = await ProductImages.get(env, imageId);
    if (!img) throw new UserError('عکس پیدا نشد.');
    await env.DB.prepare('UPDATE product_images SET sort_order = (SELECT COALESCE(MIN(sort_order), 0) - 1 FROM product_images WHERE product_id = ?1) WHERE id = ?2').bind(img.product_id, imageId).run();
    await audit(env, actor, 'product.image.primary', img.product_id, String(imageId));
    return img.product_id;
  },
};

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
  a

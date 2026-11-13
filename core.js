import { audit } from './store.js';
// Paint Shop Bot — Stage 3: roles, admins, categories, products, variants, prices, stock (single file, no dependencies).
// Bindings/secrets: DB (D1), BOT_TOKEN, WEBHOOK_SECRET, OWNER_TELEGRAM_ID, SETUP_KEY

export const MAX_BODY_BYTES = 64 * 1024;
export const STATE_TTL_MS = 30 * 60 * 1000;
export const MAX_CATEGORY_DEPTH = 3;
export const MAX_VARIANTS_PER_PRODUCT = 20;
export const MAX_SPECS = 30;
export const MAX_BULK_ITEMS = 50;
export const PAGE_SIZE = 8;
export const MAX_IMAGES_PER_PRODUCT = 8;

// ───────────────────────── utilities ─────────────────────────
export class UserError extends Error {}

export function safeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export async function tg(env, method, payload) {
  // Never log the URL: it contains the bot token.
  const res = await fetch(`https://api.telegram.org/bot${env.BOT_TOKEN}/${method}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  });
  return res.json();
}

export function cleanName(input) {
  const name = String(input ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim();
  if (name.length < 1) throw new UserError('نام نمی‌تواند خالی باشد.');
  if (name.length > 60) throw new UserError('نام حداکثر ۶۰ کاراکتر می‌تواند باشد.');
  return name;
}

// ───────────────────────── access control ─────────────────────────
export const ROLE_PERMS = {
  admin: ['catalog.manage', 'price.manage', 'stock.manage', 'orders.manage', 'payments.review', 'reports.view', 'support.manage', 'broadcast.manage'],
  operator: ['orders.manage', 'support.manage'],
};
export const ALL_PERMS = [...ROLE_PERMS.admin, 'admins.manage', 'settings.manage'];

export function isOwner(env, userId) {
  return env.OWNER_TELEGRAM_ID != null && String(userId) === String(env.OWNER_TELEGRAM_ID);
}

// Real permission lookup. Called on EVERY sensitive action (hiding buttons is not security).
export async function getAccess(env, userId) {
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

export async function requirePerm(env, userId, perm) {
  const access = await getAccess(env, userId);
  if (!access || !access.has(perm)) throw new UserError('شما دسترسی لازم برای این کار را ندارید.');
  return access;
}

// ───────────────────────── core: categories (no Telegram here) ─────────────────────────
export const Categories = {
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
export const State = {
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
export function normalizeDigits(input) {
  return String(input ?? '')
    .replace(/[۰-۹]/g, (d) => String('۰۱۲۳۴۵۶۷۸۹'.indexOf(d)))
    .replace(/[٠-٩]/g, (d) => String('٠١٢٣٤٥٦٧٨٩'.indexOf(d)))
    .replace(/[٬،,\s]/g, '')
    .replace(/٫/g, '.');
}
export function parseIntIn(text, { min, max, label }) {
  const s = normalizeDigits(text);
  if (!/^\d{1,15}$/.test(s)) throw new UserError(`${label} باید یک عدد صحیح باشد.`);
  const n = Number(s);
  if (n < min || n > max) throw new UserError(`${label} باید بین ${fmt(min)} و ${fmt(max)} باشد.`);
  return n;
}
export function parseDecimalIn(text, { min, max, label }) {
  const s = normalizeDigits(text).replace(/^−/, '-');
  if (!/^-?\d{1,6}(\.\d{1,3})?$/.test(s)) throw new UserError(`${label} باید عدد باشد (مثلاً 5 یا -3.5).`);
  const n = Number(s);
  if (n < min || n > max) throw new UserError(`${label} باید بین ${min} و ${max} باشد.`);
  return n;
}
export function cleanText(input, { min = 1, max, label }) {
  const t = String(input ?? '').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, ' ').trim();
  if (t.length < min) throw new UserError(`${label} نمی‌تواند خالی باشد.`);
  if (t.length > max) throw new UserError(`${label} حداکثر ${fmt(max)} کاراکتر می‌تواند باشد.`);
  return t;
}
export const isSkip = (t) => ['-', '—', 'ندارد'].includes(String(t ?? '').trim());
export const NUMBER_FORMAT = new Intl.NumberFormat('fa-IR');
export const fmt = (n) => NUMBER_FORMAT.format(n);
export const clip = (t) => (t.length > 3900 ? t.slice(0, 3900) + '…' : t);
export async function currencyLabel(env) {
  const r = await env.DB.prepare("SELECT value FROM store_settings WHERE key = 'currency_label'").first();
  return r?.value || 'تومان';
}
export const personLabel = (u) => `${u.first_name ?? 'بدون نام'}${u.username ? ' @' + u.username : ''} (${u.telegram_id})`;
export const uniqueViolation = (err) => /UNIQUE/i.test(String(err?.message ?? ''));
export const constraintViolation = (err) => /constraint/i.test(String(err?.message ?? ''));

export function requireOwner(env, userId) {
  if (!isOwner(env, userId)) throw new UserError('فقط مالک اصلی می‌تواند ادمین‌ها را مدیریت کند.');
}
export async function requireAnyPerm(env, userId, perms) {
  const access = await getAccess(env, userId);
  if (!access || !perms.some((p) => access.has(p))) throw new UserError('شما دسترسی لازم برای این کار را ندارید.');
  return access;
}
export const BROWSE_PERMS = ['catalog.manage', 'price.manage', 'stock.manage'];


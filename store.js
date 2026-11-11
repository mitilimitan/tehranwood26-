import { Categories, MAX_IMAGES_PER_PRODUCT, MAX_SPECS, PAGE_SIZE, ROLE_PERMS, UserError, cleanText, fmt, isOwner, isSkip, requireOwner, requirePerm, tg } from './core.js';
export async function audit(env, actor, action, target, detail) {
  await env.DB.prepare('INSERT INTO audit_logs (actor_telegram_id, action, target, detail) VALUES (?1, ?2, ?3, ?4)')
    .bind(actor, action, String(target), detail ?? null).run();
}

// ───────────────────────── core: admins (owner only) ─────────────────────────
export const Admins = {
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
export const Products = {
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
export const available = (v) => Math.max(0, v.stock_on_hand - v.stock_reserved);
export const isBuyable = (v) => v.is_active === 1 && v.is_sellable === 1 && available(v) > 0;
export const weightOf = (v) => { try { return JSON.parse(v.attributes).weight_kg ?? null; } catch { return null; } };

export const ProductImages = {
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


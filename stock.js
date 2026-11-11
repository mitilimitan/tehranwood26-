import { Categories, MAX_BULK_ITEMS, MAX_VARIANTS_PER_PRODUCT, UserError, cleanText, constraintViolation, fmt, isSkip, parseDecimalIn, parseIntIn, requirePerm, uniqueViolation } from './core.js';
import { Products, audit } from './store.js';
export const Variants = {
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

export const BulkPrice = {
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

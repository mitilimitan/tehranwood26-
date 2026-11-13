import { UserError, constraintViolation, currencyLabel, fmt, normalizeDigits, requirePerm } from './core.js';
import { audit, available, isBuyable } from './store.js';

export const MAX_CART_LINES = 10;
export const RESERVE_HOURS = 24;
const OPEN = `status = 'pending_payment' AND payment_status IN ('unpaid','rejected')`;

// ───────────────────────── store settings (card number) ─────────────────────────
export function parseCard(text) {
  const number = normalizeDigits(text).replace(/[-‐–]/g, '');
  if (!/^\d{16}$/.test(number)) throw new UserError('شماره کارت باید ۱۶ رقم باشد.');
  return number;
}
export const Settings = {
  async get(env, key) {
    const r = await env.DB.prepare('SELECT value FROM store_settings WHERE key = ?1').bind(key).first();
    return r?.value ?? null;
  },
  async put(env, key, value) {
    await env.DB.prepare(`INSERT INTO store_settings (key, value) VALUES (?1, ?2)
      ON CONFLICT(key) DO UPDATE SET value = ?2, updated_at = datetime('now')`).bind(key, value).run();
  },
  async del(env, key) { await env.DB.prepare('DELETE FROM store_settings WHERE key = ?1').bind(key).run(); },
  async card(env) {
    return { number: await Settings.get(env, 'card_number'), holder: await Settings.get(env, 'card_holder') };
  },
  async setCard(env, actor, numberText, holderText) {
    await requirePerm(env, actor, 'payments.review');
    const number = parseCard(numberText);
    const raw = String(holderText ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim();
    const holder = ['-', '—', 'ندارد'].includes(raw) ? '' : raw.slice(0, 60);
    const up = () => env.DB.prepare(`INSERT INTO store_settings (key, value) VALUES (?1, ?2)
      ON CONFLICT(key) DO UPDATE SET value = ?2, updated_at = datetime('now')`);
    await env.DB.batch([up().bind('card_number', number), up().bind('card_holder', holder)]);
    await audit(env, actor, 'settings.card', 'card_number', 'updated');
  },
};
export const cardPretty = (n) => String(n).replace(/(\d{4})(?=\d)/g, '$1-');

async function userId(env, tgId) {
  const u = await env.DB.prepare('SELECT id FROM users WHERE telegram_id = ?1').bind(tgId).first();
  if (!u) throw new UserError('لطفاً ابتدا /start را بفرستید.');
  return u.id;
}

// ───────────────────────── cart ─────────────────────────
export const Cart = {
  async items(env, tgId) {
    const u = await userId(env, tgId);
    return (await env.DB.prepare(
      `SELECT ci.variant_id, ci.quantity, v.label, v.price, v.stock_on_hand, v.stock_reserved, v.is_active, v.is_sellable,
              p.name, p.is_published
         FROM cart_items ci JOIN product_variants v ON v.id = ci.variant_id JOIN products p ON p.id = v.product_id
        WHERE ci.user_id = ?1 ORDER BY ci.rowid`).bind(u).all()).results;
  },
  async change(env, tgId, vid, delta) {
    const u = await userId(env, tgId);
    const v = await env.DB.prepare(
      `SELECT v.*, p.is_published FROM product_variants v JOIN products p ON p.id = v.product_id WHERE v.id = ?1`).bind(vid).first();
    const cur = await env.DB.prepare('SELECT quantity FROM cart_items WHERE user_id = ?1 AND variant_id = ?2').bind(u, vid).first();
    const q = (cur?.quantity ?? 0) + delta;
    if (q <= 0) { await Cart.remove(env, tgId, vid); return 0; }
    if (!v || !v.is_published || !isBuyable(v)) throw new UserError('این مورد در حال حاضر موجود نیست.');
    if (q > available(v)) throw new UserError(`حداکثر ${fmt(available(v))} عدد از این مورد قابل سفارش است.`);
    if (!cur) {
      const c = (await env.DB.prepare('SELECT COUNT(*) AS c FROM cart_items WHERE user_id = ?1').bind(u).first()).c;
      if (c >= MAX_CART_LINES) throw new UserError(`سبد خرید حداکثر ${fmt(MAX_CART_LINES)} مورد متفاوت می‌تواند داشته باشد.`);
    }
    await env.DB.batch([
      env.DB.prepare('INSERT OR IGNORE INTO carts (user_id) VALUES (?1)').bind(u),
      env.DB.prepare(`INSERT INTO cart_items (user_id, variant_id, quantity) VALUES (?1, ?2, ?3)
        ON CONFLICT(user_id, variant_id) DO UPDATE SET quantity = ?3`).bind(u, vid, q),
    ]);
    return q;
  },
  async remove(env, tgId, vid) {
    const u = await userId(env, tgId);
    await env.DB.prepare('DELETE FROM cart_items WHERE user_id = ?1 AND variant_id = ?2').bind(u, vid).run();
  },
  async clear(env, tgId) {
    const u = await userId(env, tgId);
    await env.DB.prepare('DELETE FROM cart_items WHERE user_id = ?1').bind(u).run();
  },
};

// ───────────────────────── orders ─────────────────────────
const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
function newCode() {
  const b = crypto.getRandomValues(new Uint8Array(7));
  return 'P' + [...b].map((x) => CODE_CHARS[x % CODE_CHARS.length]).join('');
}

export const Orders = {
  async get(env, id) { return env.DB.prepare('SELECT * FROM orders WHERE id = ?1').bind(id).first(); },
  async getFor(env, tgId, id) {
    const u = await userId(env, tgId);
    const o = await Orders.get(env, id);
    return o && o.user_id === u ? o : null;
  },
  async items(env, orderId) {
    return (await env.DB.prepare('SELECT * FROM order_items WHERE order_id = ?1 ORDER BY id').bind(orderId).all()).results;
  },
  async customer(env, order) {
    return env.DB.prepare('SELECT telegram_id, first_name, username FROM users WHERE id = ?1').bind(order.user_id).first();
  },
  async listFor(env, tgId) {
    const u = await userId(env, tgId);
    return (await env.DB.prepare('SELECT * FROM orders WHERE user_id = ?1 ORDER BY id DESC LIMIT 8').bind(u).all()).results;
  },
  async openFor(env, tgId) {
    const u = await userId(env, tgId);
    return env.DB.prepare(`SELECT * FROM orders WHERE user_id = ?1 AND status = 'pending_payment' ORDER BY id DESC LIMIT 1`).bind(u).first();
  },

  // Returns the problem (as a UserError) before asking the customer for delivery details.
  async precheck(env, tgId) {
    await Orders.expireDue(env);
    const open = await Orders.openFor(env, tgId);
    if (open) throw new UserError(`شما یک سفارش در انتظار پرداخت/بررسی دارید (${open.public_code}). ابتدا آن را تکمیل یا لغو کنید.`);
    if (!(await Settings.card(env)).number) throw new UserError('فروشگاه هنوز شماره کارت را ثبت نکرده است. لطفاً کمی بعد تلاش کنید.');
    const items = await Cart.items(env, tgId);
    if (!items.length) throw new UserError('سبد خرید شما خالی است.');
    for (const i of items) {
      const v = { stock_on_hand: i.stock_on_hand, stock_reserved: i.stock_reserved, is_active: i.is_active, is_sellable: i.is_sellable };
      if (!i.is_published || !isBuyable(v)) throw new UserError(`«${i.name} — ${i.label}» دیگر موجود نیست. آن را از سبد حذف کنید.`);
      if (i.quantity > available(v)) throw new UserError(`از «${i.name} — ${i.label}» فقط ${fmt(available(v))} عدد موجود است. تعداد را کم کنید.`);
    }
    return items;
  },

  async create(env, tgId, delivery) {
    await Orders.precheck(env, tgId);
    const u = await userId(env, tgId);
    const cur = await currencyLabel(env);
    const code = newCode();
    const sub = `(SELECT COALESCE(SUM(ci.quantity * v.price), 0) FROM cart_items ci JOIN product_variants v ON v.id = ci.variant_id WHERE ci.user_id = ?1)`;
    const oid = `(SELECT id FROM orders WHERE public_code = ?2)`;
    try {
      await env.DB.batch([
        env.DB.prepare(`INSERT INTO orders (public_code, user_id, status, payment_status, subtotal, discount, total, currency, delivery_info, reserved_until)
          VALUES (?2, ?1, 'pending_payment', 'unpaid', ${sub}, 0, ${sub}, ?3, ?4, datetime('now', '+${RESERVE_HOURS} hours'))`)
          .bind(u, code, cur, JSON.stringify(delivery)),
        env.DB.prepare(`INSERT INTO order_items (order_id, variant_id, product_name, variant_label, sku, unit_price, quantity)
          SELECT ${oid}, ci.variant_id, p.name, v.label, v.sku, v.price, ci.quantity
            FROM cart_items ci JOIN product_variants v ON v.id = ci.variant_id JOIN products p ON p.id = v.product_id
           WHERE ci.user_id = ?1`).bind(u, code),
        // over-reservation violates CHECK(stock_reserved <= stock_on_hand) and rolls the whole batch back
        env.DB.prepare(`UPDATE product_variants SET stock_reserved = stock_reserved +
            (SELECT ci.quantity FROM cart_items ci WHERE ci.user_id = ?1 AND ci.variant_id = product_variants.id)
          WHERE id IN (SELECT variant_id FROM cart_items WHERE user_id = ?1)`).bind(u),
        env.DB.prepare(`INSERT INTO inventory_movements (variant_id, delta_on_hand, delta_reserved, reason, order_id, actor_telegram_id)
          SELECT ci.variant_id, 0, ci.quantity, 'reserve', ${oid}, ?3 FROM cart_items ci WHERE ci.user_id = ?1`).bind(u, code, tgId),
        env.DB.prepare(`INSERT INTO order_status_history (order_id, from_status, to_status, actor, note)
          VALUES (${oid}, NULL, 'pending_payment', ?3, 'order created')`).bind(u, code, String(tgId)),
        env.DB.prepare('DELETE FROM cart_items WHERE user_id = ?1').bind(u),
      ]);
    } catch (err) {
      if (constraintViolation(err)) throw new UserError('موجودی بعضی کالاها همین الان تغییر کرد. سبد را بررسی و دوباره تلاش کنید.');
      throw err;
    }
    return env.DB.prepare('SELECT * FROM orders WHERE public_code = ?1').bind(code).first();
  },

  // Releases reserved stock of an unpaid order. Order row is updated LAST so earlier statements see the old status.
  async release(env, orderId, toStatus, actor, note) {
    const cond = `EXISTS (SELECT 1 FROM orders WHERE id = ?1 AND ${OPEN})`;
    const r = await env.DB.batch([
      env.DB.prepare(`UPDATE product_variants SET stock_reserved = stock_reserved -
          (SELECT oi.quantity FROM order_items oi WHERE oi.order_id = ?1 AND oi.variant_id = product_variants.id)
        WHERE id IN (SELECT variant_id FROM order_items WHERE order_id = ?1) AND ${cond}`).bind(orderId),
      env.DB.prepare(`INSERT INTO inventory_movements (variant_id, delta_on_hand, delta_reserved, reason, order_id, actor_telegram_id)
        SELECT variant_id, 0, -quantity, 'release', ?1, ?2 FROM order_items WHERE order_id = ?1 AND ${cond}`)
        .bind(orderId, /^\d+$/.test(actor) ? Number(actor) : null),
      env.DB.prepare(`INSERT INTO order_status_history (order_id, from_status, to_status, actor, note)
        SELECT id, status, ?2, ?3, ?4 FROM orders WHERE id = ?1 AND ${OPEN}`).bind(orderId, toStatus, actor, note),
      env.DB.prepare(`UPDATE orders SET status = ?2, updated_at = datetime('now') WHERE id = ?1 AND ${OPEN}`).bind(orderId, toStatus),
    ]);
    return r[3].meta.changes === 1;
  },
  async expireDue(env) {
    const due = (await env.DB.prepare(
      `SELECT id FROM orders WHERE ${OPEN} AND reserved_until < datetime('now') LIMIT 5`).all()).results;
    for (const o of due) await Orders.release(env, o.id, 'expired', 'system', 'payment window ended');
  },
  async cancelByCustomer(env, tgId, id) {
    const o = await Orders.getFor(env, tgId, id);
    if (!o) throw new UserError('سفارش پیدا نشد.');
    if (!(await Orders.release(env, id, 'cancelled', String(tgId), 'cancelled by customer')))
      throw new UserError('این سفارش دیگر قابل لغو نیست.');
  },

  // ── receipt
  async submitReceipt(env, tgId, orderId, fileId, uniqueId) {
    await Orders.expireDue(env);
    const o = await Orders.getFor(env, tgId, orderId);
    if (!o) throw new UserError('سفارش پیدا نشد.');
    if (o.status !== 'pending_payment' || !['unpaid', 'rejected'].includes(o.payment_status))
      throw new UserError('برای این سفارش الان نمی‌توانید رسید ارسال کنید.');
    if (o.total <= 0) throw new UserError('مبلغ این سفارش صفر است.');
    const dup = await env.DB.prepare('SELECT 1 AS x FROM payments WHERE receipt_unique_id = ?1').bind(uniqueId).first();
    if (dup) throw new UserError('این عکس قبلاً ارسال شده است. لطفاً عکس رسید خودتان را بفرستید.');
    await env.DB.batch([
      env.DB.prepare(`INSERT INTO payments (order_id, amount, currency, receipt_file_id, receipt_unique_id)
        SELECT ?1, ?2, ?3, ?4, ?5 WHERE EXISTS (SELECT 1 FROM orders WHERE id = ?1 AND ${OPEN})`).bind(o.id, o.total, o.currency, fileId, uniqueId),
      env.DB.prepare(`INSERT INTO order_status_history (order_id, from_status, to_status, actor, note)
        SELECT id, status, status, ?2, 'receipt submitted' FROM orders WHERE id = ?1 AND ${OPEN}`).bind(o.id, String(tgId)),
      env.DB.prepare(`UPDATE orders SET payment_status = 'awaiting_review', reserved_until = datetime('now', '+${RESERVE_HOURS} hours'),
        updated_at = datetime('now') WHERE id = ?1 AND ${OPEN}`).bind(o.id),
    ]);
    const pay = await env.DB.prepare('SELECT * FROM payments WHERE receipt_unique_id = ?1').bind(uniqueId).first();
    if (!pay) throw new UserError('ثبت رسید انجام نشد. دوباره تلاش کنید.');
    return { order: o, payment: pay };
  },
};

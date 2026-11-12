import { UserError, getAccess, requirePerm, tg } from './core.js';
import { Orders, RESERVE_HOURS } from './orders.js';
import { audit } from './store.js';


export const Payments = {
  async reviewerIds(env) {
    const ids = new Set();
    if (env.OWNER_TELEGRAM_ID) ids.add(Number(env.OWNER_TELEGRAM_ID));
    const rows = (await env.DB.prepare('SELECT telegram_id FROM admins WHERE is_active = 1').all()).results;
    for (const r of rows) { const a = await getAccess(env, r.telegram_id); if (a?.has('payments.review')) ids.add(r.telegram_id); }
    return [...ids];
  },
  async payment(env, id) { return env.DB.prepare('SELECT * FROM payments WHERE id = ?1').bind(id).first(); },
  async awaitingReview(env) {
    return (await env.DB.prepare(
      `SELECT p.id AS payment_id, o.* FROM payments p JOIN orders o ON o.id = p.order_id
        WHERE p.status = 'submitted' ORDER BY p.id LIMIT 10`).all()).results;
  },

  async approve(env, actor, paymentId) {
    await requirePerm(env, actor, 'payments.review');
    const pay = await Payments.payment(env, paymentId);
    if (!pay || pay.status !== 'submitted') throw new UserError('این رسید قبلاً بررسی شده است.');
    const oid = pay.order_id;
    const ps = `EXISTS (SELECT 1 FROM payments WHERE id = ?1 AND status = 'submitted')`;
    const paid = `(SELECT payment_status FROM orders WHERE id = ?2) = 'paid'`;
    await env.DB.batch([
      env.DB.prepare(`UPDATE orders SET status = 'paid', payment_status = 'paid', updated_at = datetime('now')
        WHERE id = ?2 AND payment_status = 'awaiting_review' AND ${ps}`).bind(paymentId, oid),
      env.DB.prepare(`UPDATE product_variants SET
          stock_on_hand = stock_on_hand - (SELECT oi.quantity FROM order_items oi WHERE oi.order_id = ?2 AND oi.variant_id = product_variants.id),
          stock_reserved = stock_reserved - (SELECT oi.quantity FROM order_items oi WHERE oi.order_id = ?2 AND oi.variant_id = product_variants.id)
        WHERE id IN (SELECT variant_id FROM order_items WHERE order_id = ?2) AND ${paid} AND ${ps}`).bind(paymentId, oid),
      env.DB.prepare(`INSERT INTO inventory_movements (variant_id, delta_on_hand, delta_reserved, reason, order_id, actor_telegram_id)
        SELECT variant_id, -quantity, -quantity, 'sale', ?2, ?3 FROM order_items WHERE order_id = ?2 AND ${paid} AND ${ps}`).bind(paymentId, oid, actor),
      env.DB.prepare(`INSERT INTO order_status_history (order_id, from_status, to_status, actor, note)
        SELECT ?2, 'pending_payment', 'paid', ?3, 'payment approved' WHERE ${paid} AND ${ps}`).bind(paymentId, oid, String(actor)),
      env.DB.prepare(`UPDATE payments SET status = 'approved', reviewed_by = ?2, reviewed_at = datetime('now')
        WHERE id = ?1 AND status = 'submitted'`).bind(paymentId, actor),
    ]);
    await audit(env, actor, 'payment.approve', paymentId, `order ${oid}`);
    return Orders.get(env, oid);
  },
  async reject(env, actor, paymentId, reason) {
    await requirePerm(env, actor, 'payments.review');
    const pay = await Payments.payment(env, paymentId);
    if (!pay || pay.status !== 'submitted') throw new UserError('این رسید قبلاً بررسی شده است.');
    const text = String(reason ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 200) || 'بدون توضیح';
    const ps = `EXISTS (SELECT 1 FROM payments WHERE id = ?1 AND status = 'submitted')`;
    await env.DB.batch([
      env.DB.prepare(`INSERT INTO order_status_history (order_id, from_status, to_status, actor, note)
        SELECT ?2, 'pending_payment', 'pending_payment', ?3, ?4 WHERE ${ps}`).bind(paymentId, pay.order_id, String(actor), 'receipt rejected: ' + text),
      env.DB.prepare(`UPDATE orders SET payment_status = 'rejected', reserved_until = datetime('now', '+${RESERVE_HOURS} hours'),
        updated_at = datetime('now') WHERE id = ?2 AND payment_status = 'awaiting_review' AND ${ps}`).bind(paymentId, pay.order_id),
      env.DB.prepare(`UPDATE payments SET status = 'rejected', reviewed_by = ?2, reviewed_at = datetime('now'), reject_reason = ?3
        WHERE id = ?1 AND status = 'submitted'`).bind(paymentId, actor, text),
    ]);
    await audit(env, actor, 'payment.reject', paymentId, text);
    return { order: await Orders.get(env, pay.order_id), reason: text };
  },

  NEXT: { paid: 'processing', processing: 'shipped', shipped: 'delivered' },
  async advance(env, actor, orderId, to) {
    await requirePerm(env, actor, 'orders.manage');
    const o = await Orders.get(env, orderId);
    if (!o || Payments.NEXT[o.status] !== to) throw new UserError('این تغییر وضعیت مجاز نیست.');
    const from = o.status;
    const r = await env.DB.batch([
      env.DB.prepare(`INSERT INTO order_status_history (order_id, from_status, to_status, actor, note)
        SELECT id, status, ?2, ?3, 'status change' FROM orders WHERE id = ?1 AND status = ?4`).bind(orderId, to, String(actor), from),
      env.DB.prepare(`UPDATE orders SET status = ?2, updated_at = datetime('now') WHERE id = ?1 AND status = ?3`).bind(orderId, to, from),
    ]);
    if (r[1].meta.changes !== 1) throw new UserError('وضعیت سفارش همین الان تغییر کرد. صفحه را تازه کنید.');
    await audit(env, actor, 'order.status', orderId, `${from} -> ${to}`);
    return Orders.get(env, orderId);
  },
  async recent(env) {
    return (await env.DB.prepare('SELECT * FROM orders ORDER BY id DESC LIMIT 10').all()).results;
  },
};

export async function notifyReviewers(env, text, photoFileId, keyboard) {
  for (const id of await Payments.reviewerIds(env)) {
    try {
      await tg(env, 'sendPhoto', { chat_id: id, photo: photoFileId, caption: text, reply_markup: { inline_keyboard: keyboard } });
    } catch (err) { console.error('notify failed:', err?.message ?? 'unknown'); }
  }
}

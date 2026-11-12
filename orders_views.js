import { UserError, clip, currencyLabel, fmt, requirePerm } from './core.js';
import { Cart, Orders, Settings, cardPretty } from './orders.js';
import { Payments } from './payments.js';
import { isBuyable } from './store.js';
import { btn } from './views_a.js';

export function statusLabel(o) {
  if (o.status === 'pending_payment') {
    if (o.payment_status === 'awaiting_review') return '🕓 رسید در انتظار بررسی';
    if (o.payment_status === 'rejected') return '❌ رسید رد شد — دوباره ارسال کنید';
    return '⏳ در انتظار پرداخت';
  }
  return ({ paid: '✅ پرداخت تأیید شد', processing: '📦 در حال آماده‌سازی', shipped: '🚚 ارسال شد',
    delivered: '🎉 تحویل داده شد', cancelled: '🚫 لغو شد', expired: '⌛ منقضی شد' })[o.status] ?? o.status;
}
export const isOpen = (o) => o.status === 'pending_payment' && ['unpaid', 'rejected'].includes(o.payment_status);
const hoursLeft = (s) => Math.max(0, Math.ceil((Date.parse(String(s).replace(' ', 'T') + 'Z') - Date.now()) / 36e5));
const lineOf = (i, cur) => `• ${i.product_name} — ${i.variant_label}\n   ${fmt(i.quantity)} × ${fmt(i.unit_price)} = ${fmt(i.quantity * i.unit_price)} ${cur}`;

// ── customer: cart
export async function cartView(env, tgId) {
  const items = await Cart.items(env, tgId);
  if (!items.length) return { text: '🧺 سبد خرید شما خالی است.', keyboard: [[btn('🛍 دسته‌بندی محصولات', 'c:l:0')], [btn('🏠 منوی اصلی', 'c:home')]] };
  const cur = await currencyLabel(env);
  let total = 0;
  const lines = ['🧺 سبد خرید شما:', ''];
  const rows = [];
  items.forEach((i, idx) => {
    total += i.quantity * i.price;
    const ok = i.is_published && isBuyable(i);
    lines.push(`${fmt(idx + 1)}. ${i.name} — ${i.label}${ok ? '' : ' ⚠️ ناموجود'}`, `   ${fmt(i.quantity)} × ${fmt(i.price)} = ${fmt(i.quantity * i.price)} ${cur}`);
    rows.push([btn('➖', `k:dec:${i.variant_id}`), btn(`${fmt(i.quantity)} × ${i.label}`.slice(0, 30), 'k:v'), btn('➕', `k:inc:${i.variant_id}`), btn('🗑', `k:rm:${i.variant_id}`)]);
  });
  lines.push('', `جمع کل: ${fmt(total)} ${cur}`);
  rows.push([btn('✅ ثبت سفارش', 'k:co')]);
  rows.push([btn('🛍 ادامه‌ی خرید', 'c:l:0'), btn('🧹 خالی کردن', 'k:clr')]);
  rows.push([btn('🏠 منوی اصلی', 'c:home')]);
  return { text: clip(lines.join('\n')), keyboard: rows };
}

export async function checkoutConfirmView(env, tgId, d) {
  const items = await Orders.precheck(env, tgId);
  const cur = await currencyLabel(env);
  const total = items.reduce((s, i) => s + i.quantity * i.price, 0);
  const lines = ['لطفاً سفارش را بررسی کنید:', '',
    ...items.map((i) => `• ${i.name} — ${i.label}: ${fmt(i.quantity)} × ${fmt(i.price)}`),
    '', `جمع کل: ${fmt(total)} ${cur}`, '', `گیرنده: ${d.name}`, `موبایل: ${d.phone}`, `آدرس: ${d.address}`,
    '', `با ثبت سفارش، کالاها تا ${fmt(24)} ساعت برای شما رزرو می‌شوند.`];
  return { text: clip(lines.join('\n')), keyboard: [[btn('✅ تأیید و ثبت سفارش', 'k:ok')], [btn('🔙 بازگشت به سبد', 'k:v')]] };
}

// ── customer: orders
export async function customerOrderView(env, tgId, id) {
  const o = await Orders.getFor(env, tgId, id);
  const back = [btn('📦 سفارش‌های من', 'o:l'), btn('🏠 منو', 'c:home')];
  if (!o) return { text: 'سفارش پیدا نشد.', keyboard: [back] };
  const items = await Orders.items(env, o.id);
  const lines = [`🧾 سفارش ${o.public_code}`, `وضعیت: ${statusLabel(o)}`, '', ...items.map((i) => lineOf(i, o.currency)), '', `جمع کل: ${fmt(o.total)} ${o.currency}`];
  const rows = [];
  if (isOpen(o)) {
    const card = await Settings.card(env);
    lines.push('', '💳 پرداخت کارت‌به‌کارت:', `مبلغ: ${fmt(o.total)} ${o.currency}`, `شماره کارت: ${card.number ? cardPretty(card.number) : 'ثبت نشده'}`);
    if (card.holder) lines.push(`به نام: ${card.holder}`);
    lines.push('', `پس از پرداخت، عکس رسید را از دکمه‌ی زیر بفرستید. مهلت: حدود ${fmt(hoursLeft(o.reserved_until))} ساعت دیگر.`);
    if (o.payment_status === 'rejected') {
      const r = await env.DB.prepare(`SELECT reject_reason FROM payments WHERE order_id = ?1 AND status = 'rejected' ORDER BY id DESC LIMIT 1`).bind(o.id).first();
      if (r?.reject_reason) lines.push(`دلیل رد رسید قبلی: ${r.reject_reason}`);
    }
    rows.push([btn('📸 ارسال رسید', `o:rc:${o.id}`)], [btn('🚫 لغو سفارش', `o:cx:${o.id}`)]);
  } else if (o.payment_status === 'awaiting_review') {
    lines.push('', 'رسید شما دریافت شد و پس از بررسی توسط فروشگاه نتیجه به شما اعلام می‌شود.');
  }
  rows.push(back);
  return { text: clip(lines.join('\n')), keyboard: rows };
}

export async function myOrdersView(env, tgId) {
  const list = await Orders.listFor(env, tgId);
  const rows = list.map((o) => [btn(`${o.public_code} — ${statusLabel(o)}`.slice(0, 60), `o:v:${o.id}`)]);
  rows.push([btn('🏠 منوی اصلی', 'c:home')]);
  return { text: list.length ? '📦 سفارش‌های شما:' : 'هنوز سفارشی ثبت نکرده‌اید.', keyboard: rows };
}

export async function cancelConfirmView(env, tgId, id) {
  const o = await Orders.getFor(env, tgId, id);
  if (!o || !isOpen(o)) throw new UserError('این سفارش دیگر قابل لغو نیست.');
  return { text: `سفارش ${o.public_code} لغو شود؟ کالاهای رزروشده آزاد می‌شوند.`, keyboard: [[btn('✅ بله، لغو شود', `o:cy:${o.id}`)], [btn('🔙 خیر', `o:v:${o.id}`)]] };
}

// ── staff
function who(c, d) {
  return `${d.name ?? c?.first_name ?? '—'}${c?.username ? ' @' + c.username : ''}`;
}
const parseDelivery = (o) => { try { return JSON.parse(o.delivery_info); } catch { return {}; } };

export function paymentCaption(o, items, cust) {
  const d = parseDelivery(o);
  return [`💳 رسید جدید — سفارش ${o.public_code}`, `مشتری: ${who(cust, d)}`, `مبلغ سفارش: ${fmt(o.total)} ${o.currency}`, `تعداد اقلام: ${fmt(items.length)}`].join('\n');
}
export const paymentKeyboard = (paymentId, orderId) => [
  [btn('✅ تأیید پرداخت', `pay:ok:${paymentId}`), btn('❌ رد رسید', `pay:no:${paymentId}`)],
  [btn('📄 جزئیات سفارش', `ao:v:${orderId}`)],
];

export async function adminOrderListView(env, actor) {
  await requirePerm(env, actor, 'orders.manage');
  const list = await Payments.recent(env);
  const rows = list.map((o) => [btn(`${o.public_code} — ${statusLabel(o)}`.slice(0, 60), `ao:v:${o.id}`)]);
  rows.push([btn('🔙 پنل مدیریت', 'adm:menu')]);
  return { text: list.length ? '📦 آخرین سفارش‌ها:' : 'هنوز سفارشی ثبت نشده است.', keyboard: rows };
}

export async function adminOrderView(env, actor, id) {
  const access = await requirePerm(env, actor, 'orders.manage');
  const o = await Orders.get(env, id);
  if (!o) throw new UserError('سفارش پیدا نشد.');
  const items = await Orders.items(env, o.id);
  const cust = await Orders.customer(env, o);
  const d = parseDelivery(o);
  const lines = [`🧾 سفارش ${o.public_code}`, `وضعیت: ${statusLabel(o)}`, `ثبت: ${o.created_at} (UTC)`, '',
    `گیرنده: ${who(cust, d)}`, `موبایل: ${d.phone ?? '—'}`, `آدرس: ${d.address ?? '—'}`, '',
    ...items.map((i) => lineOf(i, o.currency)), '', `جمع کل: ${fmt(o.total)} ${o.currency}`];
  const rows = [];
  const next = Payments.NEXT[o.status];
  const label = { processing: '📦 شروع آماده‌سازی', shipped: '🚚 ارسال شد', delivered: '🎉 تحویل داده شد' }[next];
  const code = { processing: 'pr', shipped: 'sh', delivered: 'dl' }[next];
  if (next) rows.push([btn(label, `ao:st:${o.id}:${code}`)]);
  if (access.has('payments.review') && o.payment_status === 'awaiting_review') {
    const p = await env.DB.prepare(`SELECT id FROM payments WHERE order_id = ?1 AND status = 'submitted' ORDER BY id DESC LIMIT 1`).bind(o.id).first();
    if (p) rows.push([btn('💳 بررسی رسید', `pay:v:${p.id}`)]);
  }
  rows.push([btn('🔙 سفارش‌ها', 'ao:l')]);
  return { text: clip(lines.join('\n')), keyboard: rows };
}

export async function reviewListView(env, actor) {
  await requirePerm(env, actor, 'payments.review');
  const list = await Payments.awaitingReview(env);
  const rows = list.map((o) => [btn(`💳 ${o.public_code} — ${fmt(o.total)} ${o.currency}`.slice(0, 60), `pay:v:${o.payment_id}`)]);
  rows.push([btn('🔙 پنل مدیریت', 'adm:menu')]);
  return { text: list.length ? 'رسیدهای در انتظار بررسی:' : 'رسیدی در انتظار بررسی نیست.', keyboard: rows };
}

export async function cardView(env, actor) {
  await requirePerm(env, actor, 'payments.review');
  const c = await Settings.card(env);
  const text = c.number
    ? `💳 شماره کارت فروشگاه:\n${cardPretty(c.number)}${c.holder ? `\nبه نام: ${c.holder}` : ''}\n\nاین شماره به مشتری‌ها برای پرداخت نمایش داده می‌شود.`
    : '💳 شماره کارت هنوز ثبت نشده است. تا ثبت نشود، مشتری‌ها نمی‌توانند سفارش بدهند.';
  return { text, keyboard: [[btn('✏️ ویرایش شماره کارت', 'set:ed')], [btn('🔙 پنل مدیریت', 'adm:menu')]] };
}

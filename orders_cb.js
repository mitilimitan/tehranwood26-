import { State, UserError, requirePerm, tg } from './core.js';
import { Cart, Orders } from './orders.js';
import { Payments } from './payments.js';
import { adminOrderListView, adminOrderView, cancelConfirmView, cardView, cartView, customerOrderView, variantPickView, myOrdersView, paymentCaption, paymentKeyboard, reviewListView, statusLabel } from './orders_views.js';
import { say, showView } from './views_b.js';

const SHOP_NS = ['k', 'o', 'ao', 'pay', 'set'];
export const isShopNs = (ns) => SHOP_NS.includes(ns);
const CODES = { pr: 'processing', sh: 'shipped', dl: 'delivered' };

async function tell(env, chatId, text) {
  try { await tg(env, 'sendMessage', { chat_id: chatId, text }); } catch (err) { console.error('notify failed:', err?.message ?? 'unknown'); }
}

// ctx: { chatId, messageId, userId, answer, ask }
export async function handleShopCallback(env, cq, ctx) {
  const { chatId, messageId, userId, answer, ask } = ctx;
  const [ns, action, a, b] = cq.data.split(':');
  const n = Number(a);
  const idOk = a !== undefined && a !== '' && Number.isInteger(n) && n > 0;
  let view = null, inPlace = false;

  if (ns === 'k') {
    if (action === 'v') view = await cartView(env, userId);
    else if (action === 'add' && idOk) {
      await Cart.change(env, userId, n, 1);
      return void (await tg(env, 'answerCallbackQuery', { callback_query_id: cq.id, text: '✅ به سبد خرید اضافه شد' }));
    } else if (action === 'inc' && idOk) { await Cart.change(env, userId, n, 1); view = await cartView(env, userId); inPlace = true; }
    else if (action === 'dec' && idOk) { await Cart.change(env, userId, n, -1); view = await cartView(env, userId); inPlace = true; }
    else if (action === 'rm' && idOk) { await Cart.remove(env, userId, n); view = await cartView(env, userId); inPlace = true; }
    else if (action === 'clr') { await Cart.clear(env, userId); view = await cartView(env, userId); inPlace = true; }
    else if (action === 's' && idOk) view = await variantPickView(env, n, 1);
    else if (action === 'q' && idOk) { view = await variantPickView(env, n, Number(b)); inPlace = true; }
    else if (action === 'a' && idOk) {
      const q = Number(b);
      if (!Number.isInteger(q) || q < 1 || q > 999) throw new UserError('تعداد نامعتبر است.');
      await Cart.change(env, userId, n, q);
      view = await cartView(env, userId);
    } else if (action === 't' && idOk) return ask('cart_qty', { vid: n }, 'تعداد مورد نظر را به‌صورت عدد بفرستید:');
    else if (action === 'co') {
      await Orders.precheck(env, userId);
      return ask('ord_name', {}, 'نام و نام خانوادگی گیرنده را بفرستید:');
    } else if (action === 'ok') {
      const st = await State.get(env, userId);
      if (!st || st.action !== 'ord_confirm') throw new UserError('زمان تأیید گذشته است. دوباره از سبد خرید شروع کنید.');
      const order = await Orders.create(env, userId, { name: st.payload.name, phone: st.payload.phone, address: st.payload.address });
      await State.clear(env, userId);
      view = await customerOrderView(env, userId, order.id);
    }
  } else if (ns === 'o') {
    if (action === 'l') view = await myOrdersView(env, userId);
    else if (action === 'v' && idOk) view = await customerOrderView(env, userId, n);
    else if (action === 'rc' && idOk) {
      const o = await Orders.getFor(env, userId, n);
      if (!o || o.status !== 'pending_payment' || !['unpaid', 'rejected'].includes(o.payment_status)) throw new UserError('برای این سفارش الان نمی‌توانید رسید ارسال کنید.');
      return ask('ord_receipt', { orderId: n }, 'عکس رسید پرداخت را همین‌جا بفرستید (به‌صورت عکس، نه فایل).');
    } else if (action === 'cx' && idOk) view = await cancelConfirmView(env, userId, n);
    else if (action === 'cy' && idOk) { await Orders.cancelByCustomer(env, userId, n); view = await myOrdersView(env, userId); }
  } else if (ns === 'ao') {
    if (action === 'l') view = await adminOrderListView(env, userId);
    else if (action === 'rv') view = await reviewListView(env, userId);
    else if (action === 'v' && idOk) view = await adminOrderView(env, userId, n);
    else if (action === 'st' && idOk && CODES[b]) {
      const o = await Payments.advance(env, userId, n, CODES[b]);
      const cust = await Orders.customer(env, o);
      await tell(env, cust.telegram_id, `سفارش ${o.public_code}: ${statusLabel(o)}`);
      view = await adminOrderView(env, userId, n);
    }
  } else if (ns === 'pay') {
    await requirePerm(env, userId, 'payments.review');
    const pay = idOk ? await Payments.payment(env, n) : null;
    if (!pay) throw new UserError('رسید پیدا نشد.');
    if (pay.status !== 'submitted') throw new UserError('این رسید قبلاً بررسی شده است.');
    const order = await Orders.get(env, pay.order_id);
    if (action === 'v') {
      const items = await Orders.items(env, order.id);
      const cust = await Orders.customer(env, order);
      await answer();
      await tg(env, 'sendPhoto', { chat_id: chatId, photo: pay.receipt_file_id, caption: paymentCaption(order, items, cust), reply_markup: { inline_keyboard: paymentKeyboard(pay.id, order.id) } });
      return;
    }
    if (action === 'ok') {
      const o = await Payments.approve(env, userId, n);
      const cust = await Orders.customer(env, o);
      await tell(env, cust.telegram_id, `✅ پرداخت سفارش ${o.public_code} تأیید شد. سفارش شما در حال آماده‌سازی است.`);
      await tg(env, 'editMessageReplyMarkup', { chat_id: chatId, message_id: messageId, reply_markup: { inline_keyboard: [] } });
      await answer();
      return say(env, chatId, `✅ پرداخت سفارش ${o.public_code} تأیید شد.`);
    }
    if (action === 'no') {
      await tg(env, 'editMessageReplyMarkup', { chat_id: chatId, message_id: messageId, reply_markup: { inline_keyboard: [] } });
      return ask('pay_reject', { paymentId: n }, `دلیل رد رسید سفارش ${order.public_code} را بنویسید (برای مشتری ارسال می‌شود):`);
    }
  } else if (ns === 'set') {
    if (action === 'card') view = await cardView(env, userId);
    else if (action === 'ed') {
      await requirePerm(env, userId, 'payments.review');
      return ask('set_card', {}, 'شماره کارت ۱۶ رقمی فروشگاه را بفرستید:');
    }
  }
  await answer();
  if (view) await showView(env, chatId, messageId, view, { inPlace });
}

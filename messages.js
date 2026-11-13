import { State, UserError, getAccess, tg } from './core.js';
import { Gate, welcomeText } from './config.js';
import { handleState } from './flows.js';
import { cartView, myOrdersView } from './orders_views.js';
import { adminMenuView, customerHome } from './views_a.js';
import { say, showView, upsertUser } from './views_b.js';

export const CUSTOMER_COMMANDS = [
  { command: 'start', description: 'شروع / منوی اصلی' },
  { command: 'cart', description: 'سبد خرید' },
  { command: 'orders', description: 'سفارش‌های من' },
  { command: 'support', description: 'پشتیبانی' },
  { command: 'help', description: 'راهنما' },
];
export const STAFF_COMMANDS = [...CUSTOMER_COMMANDS, { command: 'admin', description: 'پنل مدیریت' }];
const HELP = 'راهنما:\n/start — منوی اصلی\n/cart — سبد خرید\n/orders — سفارش‌های من\n/support — پیام به پشتیبانی\n/cancel — لغو عملیات جاری\n\nبرای خرید: دسته‌بندی ← محصول ← بسته‌بندی ← تعداد ← سبد خرید ← ثبت سفارش ← پرداخت و ارسال عکس رسید.';

export async function handleMessage(env, msg) {
  if (!msg.from || msg.chat?.type !== 'private') return;
  const userId = msg.from.id, chatId = msg.chat.id;
  await upsertUser(env, msg.from);
  const text = (msg.text ?? '').trim();
  const cmd = text.startsWith('/') ? text.split(/\s/)[0].split('@')[0].toLowerCase() : '';

  try {
    if (cmd === '/cancel') {
      await State.clear(env, userId);
      await say(env, chatId, 'عملیات لغو شد.');
      return;
    }
    if (await Gate.blocks(env, userId, chatId, null)) return;

    if (cmd === '/start') {
      await State.clear(env, userId);
      const staff = !!(await getAccess(env, userId));
      if (staff) await tg(env, 'setMyCommands', { commands: STAFF_COMMANDS, scope: { type: 'chat', chat_id: chatId } });
      const view = customerHome(env, staff);
      await showView(env, chatId, null, { ...view, text: await welcomeText(env, msg.from.first_name) });
      return;
    }
    if (cmd === '/menu') { await State.clear(env, userId); return showView(env, chatId, null, customerHome(env, !!(await getAccess(env, userId)))); }
    if (cmd === '/admin') return showView(env, chatId, null, await adminMenuView(env, userId));
    if (cmd === '/cart') return showView(env, chatId, null, await cartView(env, userId));
    if (cmd === '/orders') return showView(env, chatId, null, await myOrdersView(env, userId));
    if (cmd === '/help') return say(env, chatId, HELP);
    if (cmd === '/support') {
      await State.set(env, userId, 'sp_msg', {});
      return say(env, chatId, 'پیام یا سؤال خود را بنویسید. پاسخ پشتیبانی همین‌جا برایتان ارسال می‌شود.\n(برای لغو: /cancel)');
    }
    const state = await State.get(env, userId);
    if (!state || cmd) return;
    await handleState(env, userId, chatId, state, text, msg);
  } catch (err) {
    if (err instanceof UserError) { await say(env, chatId, `⚠️ ${err.message}`); return; }
    throw err;
  }
}

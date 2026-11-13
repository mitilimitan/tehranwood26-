import { UserError, clip, cleanText, getAccess, personLabel, requirePerm, tg } from './core.js';
import { audit } from './store.js';
import { btn } from './views_a.js';
import { say, showView } from './views_b.js';

export const MAX_SUPPORT_PER_HOUR = 10;

export async function staffWith(env, perm) {
  const ids = new Set();
  if (env.OWNER_TELEGRAM_ID) ids.add(Number(env.OWNER_TELEGRAM_ID));
  const rows = (await env.DB.prepare('SELECT telegram_id FROM admins WHERE is_active = 1').all()).results;
  for (const r of rows) { const a = await getAccess(env, r.telegram_id); if (a?.has(perm)) ids.add(r.telegram_id); }
  return [...ids];
}

export const Support = {
  async send(env, tgId, text) {
    const body = cleanText(text, { min: 2, max: 1000, label: 'پیام' });
    const u = await env.DB.prepare('SELECT id, telegram_id, first_name, username FROM users WHERE telegram_id = ?1').bind(tgId).first();
    if (!u) throw new UserError('لطفاً ابتدا /start را بفرستید.');
    const recent = (await env.DB.prepare(
      `SELECT COUNT(*) AS c FROM support_messages m JOIN support_tickets t ON t.id = m.ticket_id
        WHERE t.user_id = ?1 AND m.sender = 'customer' AND m.created_at > datetime('now', '-1 hour')`).bind(u.id).first()).c;
    if (recent >= MAX_SUPPORT_PER_HOUR) throw new UserError('تعداد پیام‌های شما در یک ساعت گذشته زیاد بوده است. کمی بعد دوباره پیام بدهید.');
    let t = await env.DB.prepare(`SELECT id FROM support_tickets WHERE user_id = ?1 AND status = 'open' ORDER BY id DESC LIMIT 1`).bind(u.id).first();
    if (!t) t = { id: (await env.DB.prepare('INSERT INTO support_tickets (user_id) VALUES (?1)').bind(u.id).run()).meta.last_row_id };
    await env.DB.batch([
      env.DB.prepare(`INSERT INTO support_messages (ticket_id, sender, body) VALUES (?1, 'customer', ?2)`).bind(t.id, body),
      env.DB.prepare(`UPDATE support_tickets SET updated_at = datetime('now') WHERE id = ?1`).bind(t.id),
    ]);
    return { ticketId: t.id, user: u, body };
  },
  async notifyStaff(env, { ticketId, user, body }) {
    const text = `💬 پیام جدید پشتیبانی (#${ticketId})\nاز: ${personLabel(user)}\n\n${clip(body)}`;
    const kb = [[btn('✍️ پاسخ', `sp:r:${ticketId}`), btn('✅ بستن گفتگو', `sp:x:${ticketId}`)]];
    for (const id of await staffWith(env, 'support.manage')) {
      try { await tg(env, 'sendMessage', { chat_id: id, text, reply_markup: { inline_keyboard: kb } }); } catch (err) { console.error('notify failed:', err?.message ?? 'unknown'); }
    }
  },
  async ticket(env, id) {
    return env.DB.prepare(`SELECT t.*, u.telegram_id AS customer_tg, u.first_name, u.username FROM support_tickets t JOIN users u ON u.id = t.user_id WHERE t.id = ?1`).bind(id).first();
  },
  async reply(env, actor, ticketId, text) {
    await requirePerm(env, actor, 'support.manage');
    const body = cleanText(text, { min: 1, max: 2000, label: 'پاسخ' });
    const t = await Support.ticket(env, ticketId);
    if (!t) throw new UserError('گفتگو پیدا نشد.');
    if (t.status !== 'open') throw new UserError('این گفتگو بسته شده است.');
    await env.DB.batch([
      env.DB.prepare(`INSERT INTO support_messages (ticket_id, sender, admin_telegram_id, body) VALUES (?1, 'admin', ?2, ?3)`).bind(ticketId, actor, body),
      env.DB.prepare(`UPDATE support_tickets SET updated_at = datetime('now') WHERE id = ?1`).bind(ticketId),
    ]);
    return { customerTg: t.customer_tg, body };
  },
  async close(env, actor, id) {
    await requirePerm(env, actor, 'support.manage');
    const r = await env.DB.prepare(`UPDATE support_tickets SET status = 'closed', updated_at = datetime('now') WHERE id = ?1 AND status = 'open'`).bind(id).run();
    if (r.meta.changes !== 1) throw new UserError('این گفتگو قبلاً بسته شده است.');
    await audit(env, actor, 'support.close', id, null);
  },
  async list(env) {
    return (await env.DB.prepare(
      `SELECT t.id, u.first_name, u.username, u.telegram_id,
              (SELECT body FROM support_messages WHERE ticket_id = t.id ORDER BY id DESC LIMIT 1) AS last_body,
              (SELECT sender FROM support_messages WHERE ticket_id = t.id ORDER BY id DESC LIMIT 1) AS last_sender
         FROM support_tickets t JOIN users u ON u.id = t.user_id WHERE t.status = 'open' ORDER BY t.updated_at DESC LIMIT 10`).all()).results;
  },
  async thread(env, id) {
    return (await env.DB.prepare(`SELECT sender, body FROM (SELECT * FROM support_messages WHERE ticket_id = ?1 ORDER BY id DESC LIMIT 8) ORDER BY id`).bind(id).all()).results;
  },
};

export async function supportListView(env, actor) {
  await requirePerm(env, actor, 'support.manage');
  const list = await Support.list(env);
  const rows = list.map((t) => [btn(`${t.last_sender === 'customer' ? '🔴' : '🟢'} ${t.first_name ?? t.telegram_id} — ${String(t.last_body).slice(0, 28)}`, `sp:v:${t.id}`)]);
  rows.push([btn('🔙 پنل مدیریت', 'adm:menu')]);
  return { text: list.length ? '💬 گفتگوهای باز (🔴 منتظر پاسخ، 🟢 پاسخ داده‌شده):' : 'گفتگوی بازی وجود ندارد.', keyboard: rows };
}
export async function supportThreadView(env, actor, id) {
  await requirePerm(env, actor, 'support.manage');
  const t = await Support.ticket(env, id);
  if (!t) throw new UserError('گفتگو پیدا نشد.');
  const msgs = await Support.thread(env, id);
  const lines = [`💬 گفتگو #${id} با ${personLabel({ first_name: t.first_name, username: t.username, telegram_id: t.customer_tg })}`, t.status === 'open' ? '' : '(بسته شده)', ...msgs.map((m) => `${m.sender === 'customer' ? '👤' : '🧑‍💼'} ${m.body}`)];
  const rows = t.status === 'open' ? [[btn('✍️ پاسخ', `sp:r:${id}`), btn('✅ بستن گفتگو', `sp:x:${id}`)]] : [];
  rows.push([btn('🔙 گفتگوها', 'sp:l')]);
  return { text: clip(lines.join('\n')), keyboard: rows };
}

export const isSupportNs = (ns) => ns === 'sp';
export async function handleSupportCallback(env, cq, { chatId, messageId, userId, answer, ask }) {
  const [, action, a] = cq.data.split(':');
  const n = Number(a);
  const idOk = a !== undefined && Number.isInteger(n) && n > 0;
  let view = null;
  if (action === 'new') return ask('sp_msg', {}, 'پیام یا سؤال خود را بنویسید. پاسخ پشتیبانی همین‌جا برایتان ارسال می‌شود.');
  if (action === 'l') view = await supportListView(env, userId);
  else if (action === 'v' && idOk) view = await supportThreadView(env, userId, n);
  else if (action === 'r' && idOk) {
    await requirePerm(env, userId, 'support.manage');
    const t = await Support.ticket(env, n);
    if (!t || t.status !== 'open') throw new UserError('این گفتگو بسته شده است.');
    return ask('sp_reply', { ticketId: n }, `پاسخ خود را برای گفتگوی #${n} بنویسید:`);
  } else if (action === 'x' && idOk) { await Support.close(env, userId, n); view = await supportListView(env, userId); }
  await answer();
  if (view) await showView(env, chatId, messageId, view);
}

export async function stateSupport(env, userId, chatId, state, text) {
  if (state.action === 'sp_msg') {
    const r = await Support.send(env, userId, text);
    await Support.notifyStaff(env, r);
    await say(env, chatId, '✅ پیام شما ثبت شد. پاسخ پشتیبانی همین‌جا برایتان ارسال می‌شود.');
    return true;
  }
  if (state.action === 'sp_reply') {
    const r = await Support.reply(env, userId, state.payload.ticketId, text);
    try {
      await tg(env, 'sendMessage', { chat_id: r.customerTg, text: `💬 پاسخ پشتیبانی:\n${r.body}`, reply_markup: { inline_keyboard: [[btn('✉️ ارسال پیام جدید', 'sp:new')]] } });
    } catch { /* customer may have blocked the bot */ }
    await say(env, chatId, '✅ پاسخ برای مشتری ارسال شد.');
    return true;
  }
  return false;
}

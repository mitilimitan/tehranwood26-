import { UserError, clip, fmt, requirePerm, tg } from './core.js';
import { audit } from './store.js';
import { btn } from './views_a.js';
import { say, showView } from './views_b.js';

// One batch per request/cron tick. 40 keeps a request under the free-plan limit (50 subrequests);
// on a paid plan set the BROADCAST_CHUNK variable (up to 500) for much faster sending.
export const chunkSize = (env) => Math.min(500, Math.max(1, Number(env.BROADCAST_CHUNK) || 40));
const MEDIA = ['photo', 'video', 'audio', 'voice', 'document', 'animation', 'video_note'];
const STATUS = { draft: '📝 پیش‌نویس', sending: '📤 در حال ارسال', done: '✅ تمام شد', cancelled: '⛔ متوقف شد' };

export const Broadcast = {
  async get(env, id) { return env.DB.prepare('SELECT * FROM broadcasts WHERE id = ?1').bind(id).first(); },
  async create(env, actor, chatId, messageId) {
    await requirePerm(env, actor, 'broadcast.manage');
    const total = (await env.DB.prepare('SELECT COUNT(*) AS c FROM users WHERE bot_blocked = 0').first()).c;
    if (!total) throw new UserError('هنوز کاربری برای ارسال وجود ندارد.');
    const r = await env.DB.prepare('INSERT INTO broadcasts (created_by, source_chat_id, source_message_id, total) VALUES (?1, ?2, ?3, ?4)')
      .bind(actor, chatId, messageId, total).run();
    return { id: r.meta.last_row_id, total };
  },
  async confirm(env, actor, id) {
    await requirePerm(env, actor, 'broadcast.manage');
    const r = await env.DB.prepare(`UPDATE broadcasts SET status = 'sending', started_at = datetime('now') WHERE id = ?1 AND status = 'draft'`).bind(id).run();
    if (r.meta.changes !== 1) throw new UserError('این پیام قبلاً تأیید یا لغو شده است.');
    await audit(env, actor, 'broadcast.start', id, null);
  },
  async stop(env, actor, id) {
    await requirePerm(env, actor, 'broadcast.manage');
    const r = await env.DB.prepare(`UPDATE broadcasts SET status = 'cancelled', finished_at = datetime('now') WHERE id = ?1 AND status IN ('draft','sending')`).bind(id).run();
    if (r.meta.changes !== 1) throw new UserError('این ارسال دیگر قابل توقف نیست.');
    await audit(env, actor, 'broadcast.stop', id, null);
  },
  // Sends one batch. The lock stops a cron tick and an admin tap from sending the same batch twice.
  async chunk(env, id) {
    const got = await env.DB.prepare(`UPDATE broadcasts SET lock_until = datetime('now', '+55 seconds')
      WHERE id = ?1 AND status = 'sending' AND (lock_until IS NULL OR lock_until < datetime('now'))`).bind(id).run();
    if (got.meta.changes !== 1) return false;
    const b = await Broadcast.get(env, id);
    const size = chunkSize(env);
    const users = (await env.DB.prepare('SELECT id, telegram_id FROM users WHERE id > ?1 AND bot_blocked = 0 ORDER BY id LIMIT ?2')
      .bind(b.last_user_id, size).all()).results;
    let sent = 0, failed = 0, blocked = 0, last = b.last_user_id, throttled = false;
    for (const u of users) {
      let r;
      try { r = await tg(env, 'copyMessage', { chat_id: u.telegram_id, from_chat_id: b.source_chat_id, message_id: b.source_message_id }); }
      catch { r = { ok: false, error_code: 0 }; }
      if (r.ok) sent++;
      else if (r.error_code === 429) { throttled = true; break; }
      else if (r.error_code === 403) { blocked++; await env.DB.prepare('UPDATE users SET bot_blocked = 1 WHERE id = ?1').bind(u.id).run(); }
      else failed++;
      last = u.id;
    }
    const finished = !throttled && users.length < size ? 1 : 0;
    await env.DB.prepare(`UPDATE broadcasts SET sent = sent + ?2, failed = failed + ?3, blocked = blocked + ?4, last_user_id = ?5,
        status = CASE WHEN ?6 = 1 AND status = 'sending' THEN 'done' ELSE status END,
        finished_at = CASE WHEN ?6 = 1 AND status = 'sending' THEN datetime('now') ELSE finished_at END, lock_until = NULL WHERE id = ?1`)
      .bind(id, sent, failed, blocked, last, finished).run();
    if (finished) {
      const after = await Broadcast.get(env, id);
      if (after.status === 'done') {
        try {
          await tg(env, 'sendMessage', { chat_id: after.created_by, text: `✅ پیام همگانی #${id} کامل ارسال شد.\nارسال‌شده: ${fmt(after.sent)} از ${fmt(after.total)}\nربات را بلاک کرده‌اند: ${fmt(after.blocked)}\nناموفق: ${fmt(after.failed)}` });
        } catch { /* the sender may have blocked the bot */ }
      }
    }
    return true;
  },
  async tick(env) {
    const b = await env.DB.prepare(`SELECT id FROM broadcasts WHERE status = 'sending' ORDER BY id LIMIT 1`).first();
    if (b) await Broadcast.chunk(env, b.id);
  },
};

export async function broadcastListView(env, actor) {
  await requirePerm(env, actor, 'broadcast.manage');
  const list = (await env.DB.prepare(`SELECT * FROM broadcasts WHERE status != 'draft' ORDER BY id DESC LIMIT 6`).all()).results;
  const rows = [[btn('➕ پیام همگانی جدید', 'bc:new')]];
  for (const b of list) rows.push([btn(`#${b.id} ${STATUS[b.status]} — ${fmt(b.sent)}/${fmt(b.total)}`, `bc:v:${b.id}`)]);
  rows.push([btn('🔙 پنل مدیریت', 'adm:menu')]);
  return { text: '📣 پیام همگانی\nمی‌توانید متن، عکس، ویدیو، صوت یا فایل برای همه‌ی کاربران ربات بفرستید.', keyboard: rows };
}
export async function broadcastView(env, actor, id) {
  await requirePerm(env, actor, 'broadcast.manage');
  const b = await Broadcast.get(env, id);
  if (!b) throw new UserError('ارسال پیدا نشد.');
  const lines = [`📣 پیام همگانی #${b.id} — ${STATUS[b.status]}`, '', `گیرنده‌ها: ${fmt(b.total)}`, `ارسال‌شده: ${fmt(b.sent)}`, `ربات را بلاک کرده‌اند: ${fmt(b.blocked)}`, `ناموفق: ${fmt(b.failed)}`];
  const rows = [];
  if (b.status === 'sending') {
    lines.push('', 'ارسال خودکار ادامه دارد و پایانش به شما اطلاع داده می‌شود. «ادامه» فقط برای سرعت دادن است.');
    rows.push([btn('▶️ ادامه / به‌روزرسانی', `bc:go:${b.id}`)], [btn('⛔ توقف', `bc:st:${b.id}`)]);
  } else if (b.status === 'draft') rows.push([btn('✅ ارسال به همه', `bc:ok:${b.id}`)], [btn('❌ لغو', `bc:st:${b.id}`)]);
  rows.push([btn('🔙 پیام‌های همگانی', 'bc:l')]);
  return { text: clip(lines.join('\n')), keyboard: rows };
}

export const isBroadcastNs = (ns) => ns === 'bc';
export async function handleBroadcastCallback(env, cq, { chatId, messageId, userId, answer, ask }) {
  const [, action, a] = cq.data.split(':');
  const n = Number(a);
  const idOk = a !== undefined && Number.isInteger(n) && n > 0;
  let view = null;
  if (action === 'new') { await requirePerm(env, userId, 'broadcast.manage'); return ask('bc_msg', {}, 'پیام همگانی را همین‌جا بفرستید: متن، عکس، ویدیو، صوت یا فایل (هر بار فقط یک پیام، نه آلبوم). این پیام را بعداً پاک نکنید.'); }
  if (action === 'l') view = await broadcastListView(env, userId);
  else if (action === 'v' && idOk) view = await broadcastView(env, userId, n);
  else if (action === 'ok' && idOk) { await Broadcast.confirm(env, userId, n); await Broadcast.chunk(env, n); view = await broadcastView(env, userId, n); }
  else if (action === 'go' && idOk) { await requirePerm(env, userId, 'broadcast.manage'); await Broadcast.chunk(env, n); view = await broadcastView(env, userId, n); }
  else if (action === 'st' && idOk) { await Broadcast.stop(env, userId, n); view = await broadcastView(env, userId, n); }
  await answer();
  if (view) await showView(env, chatId, messageId, view);
}

export async function stateBroadcast(env, userId, chatId, state, msg) {
  if (state.action !== 'bc_msg') return false;
  await requirePerm(env, userId, 'broadcast.manage');
  if (!msg?.message_id) return false;
  if (msg.media_group_id) throw new UserError('لطفاً هر بار فقط یک پیام یا یک فایل بفرستید، نه آلبوم.');
  if (!(msg.text || MEDIA.some((k) => msg[k]))) throw new UserError('این نوع پیام پشتیبانی نمی‌شود. متن، عکس، ویدیو، صوت یا فایل بفرستید.');
  const pre = await tg(env, 'copyMessage', { chat_id: chatId, from_chat_id: chatId, message_id: msg.message_id });
  if (!pre.ok) throw new UserError('این پیام قابل ارسال نیست. پیام دیگری بفرستید.');
  const { id, total } = await Broadcast.create(env, userId, chatId, msg.message_id);
  await showView(env, chatId, null, {
    text: `پیش‌نمایش پیام بالا برای ${fmt(total)} کاربر ارسال می‌شود. تأیید می‌کنید؟`,
    keyboard: [[btn('✅ ارسال به همه', `bc:ok:${id}`)], [btn('❌ لغو', `bc:st:${id}`)]],
  });
  return true;
}

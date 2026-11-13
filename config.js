import { State, UserError, cleanText, getAccess, normalizeDigits, requirePerm, tg } from './core.js';
import { Settings } from './orders.js';
import { audit } from './store.js';
import { btn, customerHome } from './views_a.js';
import { say, showView } from './views_b.js';

export const DEFAULT_WELCOME = 'سلام {name} 👋\nبه فروشگاه رنگ خوش آمدید.\nاز دکمه‌های زیر می‌توانید محصولات را ببینید، سفارش بدهید یا با پشتیبانی در تماس باشید.';
export async function welcomeText(env, firstName) {
  const t = (await Settings.get(env, 'welcome_text')) || DEFAULT_WELCOME;
  return t.replaceAll('{name}', firstName ?? '').replace(/ +\n/g, '\n').trim();
}

// ───────────────────────── required channel ─────────────────────────
function parseChannel(input) {
  const t = String(input ?? '').trim();
  let m = t.match(/^(?:https?:\/\/)?(?:t|telegram)\.me\/([A-Za-z][A-Za-z0-9_]{4,31})\/?$/i) || t.match(/^@([A-Za-z][A-Za-z0-9_]{4,31})$/);
  if (m) return { chat: '@' + m[1], needLink: false };
  const id = normalizeDigits(t);
  if (/^-100\d{6,14}$/.test(id)) return { chat: id, needLink: true };
  throw new UserError('آدرس کانال معتبر نیست. مثال: @mychannel یا https://t.me/mychannel (برای کانال خصوصی، شناسه‌ی عددی مثل -1001234567890).');
}
const parseLink = (t) => {
  const s = String(t ?? '').trim();
  if (!/^(https?:\/\/)?t\.me\/[A-Za-z0-9_+\-]{3,64}\/?$/.test(s)) throw new UserError('لینک معتبر نیست. مثال: https://t.me/+AbCdEf');
  return s.startsWith('http') ? s : 'https://' + s;
};

export const Gate = {
  async config(env) {
    const chat = await Settings.get(env, 'required_channel');
    return chat ? { chat, link: await Settings.get(env, 'channel_link') } : null;
  },
  async isMember(env, userId) {
    const cfg = await Gate.config(env);
    if (!cfg) return true;
    try {
      const r = await tg(env, 'getChatMember', { chat_id: cfg.chat, user_id: userId });
      if (!r.ok) { console.error('gate check failed:', r.description); return true; } // misconfiguration must not lock everyone out
      const s = r.result?.status;
      return ['creator', 'administrator', 'member'].includes(s) || (s === 'restricted' && r.result.is_member === true);
    } catch (err) { console.error('gate check error:', err?.message ?? 'unknown'); return true; }
  },
  async view(env) {
    const cfg = await Gate.config(env);
    const link = cfg?.link || (cfg?.chat?.startsWith('@') ? `https://t.me/${cfg.chat.slice(1)}` : null);
    const rows = [];
    if (link) rows.push([{ text: '📢 عضویت در کانال', url: link }]);
    rows.push([btn('✅ عضو شدم', 'gate:chk')]);
    return { text: 'برای استفاده از ربات، ابتدا باید در کانال ما عضو شوید.\nپس از عضویت، دکمه‌ی «عضو شدم» را بزنید.', keyboard: rows };
  },
  // true => the user was blocked and the join screen was shown
  async blocks(env, userId, chatId, messageId) {
    if (!(await Gate.config(env))) return false;
    if (await getAccess(env, userId)) return false; // staff are never locked out
    if (await Gate.isMember(env, userId)) return false;
    await showView(env, chatId, messageId, await Gate.view(env));
    return true;
  },
  async set(env, actor, chat, link) {
    await requirePerm(env, actor, 'settings.manage');
    const r = await tg(env, 'getChatMember', { chat_id: chat, user_id: actor });
    if (!r.ok) throw new UserError('ربات نتوانست کانال را بررسی کند. مطمئن شوید ۱) آدرس درست است ۲) ربات در کانال «ادمین» شده است.');
    await Settings.put(env, 'required_channel', chat);
    if (link) await Settings.put(env, 'channel_link', link); else await Settings.del(env, 'channel_link');
    await audit(env, actor, 'settings.channel', chat, 'enabled');
  },
  async clear(env, actor) {
    await requirePerm(env, actor, 'settings.manage');
    await Settings.del(env, 'required_channel'); await Settings.del(env, 'channel_link');
    await audit(env, actor, 'settings.channel', '-', 'disabled');
  },
};

export async function welcomeView(env, actor) {
  await requirePerm(env, actor, 'catalog.manage');
  const cur = await Settings.get(env, 'welcome_text');
  return { text: `👋 پیام خوش‌آمد فعلی:\n\n${cur || DEFAULT_WELCOME}\n\n(در متن می‌توانید {name} بنویسید تا با نام کاربر جایگزین شود.)`,
    keyboard: [[btn('✏️ ویرایش پیام', 'cfg:we')], [btn('↩️ بازگشت به پیام پیش‌فرض', 'cfg:wd')], [btn('🔙 پنل مدیریت', 'adm:menu')]] };
}
export async function channelView(env, actor) {
  await requirePerm(env, actor, 'settings.manage');
  const cfg = await Gate.config(env);
  const text = cfg ? `📢 عضویت اجباری فعال است.\nکانال: ${cfg.chat}${cfg.link ? `\nلینک: ${cfg.link}` : ''}\n\nربات باید در این کانال ادمین باشد. مالک و ادمین‌ها از این قانون معاف‌اند.`
    : '📢 عضویت اجباری خاموش است. با فعال کردن آن، کاربران تا عضو کانال نشوند نمی‌توانند از ربات استفاده کنند.\n\nقبل از فعال‌سازی، ربات را در کانال «ادمین» کنید.';
  const rows = [[btn(cfg ? '✏️ تغییر کانال' : '➕ فعال‌سازی', 'cfg:ce')]];
  if (cfg) rows.push([btn('⛔ خاموش کردن', 'cfg:cd')]);
  rows.push([btn('🔙 پنل مدیریت', 'adm:menu')]);
  return { text, keyboard: rows };
}

export const isCfgNs = (ns) => ns === 'cfg' || ns === 'gate';
export async function handleCfgCallback(env, cq, { chatId, messageId, userId, answer, ask }) {
  const [ns, action] = cq.data.split(':');
  let view = null;
  if (ns === 'gate') {
    if (!(await Gate.isMember(env, userId))) return answer('هنوز عضو کانال نشده‌اید. ابتدا عضو شوید و دوباره دکمه را بزنید.');
    await answer();
    return showView(env, chatId, messageId, customerHome(env, !!(await getAccess(env, userId))));
  }
  if (action === 'w') view = await welcomeView(env, userId);
  else if (action === 'we') { await requirePerm(env, userId, 'catalog.manage'); return ask('cfg_welcome', {}, 'متن پیام خوش‌آمد را بفرستید (می‌توانید {name} را برای نام کاربر بنویسید):'); }
  else if (action === 'wd') { await requirePerm(env, userId, 'catalog.manage'); await Settings.del(env, 'welcome_text'); view = await welcomeView(env, userId); }
  else if (action === 'ch') view = await channelView(env, userId);
  else if (action === 'ce') { await requirePerm(env, userId, 'settings.manage'); return ask('cfg_chan', {}, 'آدرس کانال را بفرستید. مثال: @mychannel\nربات باید قبلاً در کانال ادمین شده باشد.'); }
  else if (action === 'cd') { await Gate.clear(env, userId); view = await channelView(env, userId); }
  await answer();
  if (view) await showView(env, chatId, messageId, view);
}

export async function stateConfig(env, userId, chatId, state, text) {
  const p = state.payload;
  if (state.action === 'cfg_welcome') {
    await requirePerm(env, userId, 'catalog.manage');
    const t = cleanText(text, { min: 5, max: 800, label: 'پیام خوش‌آمد' });
    await Settings.put(env, 'welcome_text', t);
    await showView(env, chatId, null, await welcomeView(env, userId));
    return true;
  }
  if (state.action === 'cfg_chan') {
    await requirePerm(env, userId, 'settings.manage');
    const c = parseChannel(text);
    if (c.needLink) { await State.set(env, userId, 'cfg_link', { chat: c.chat }); await say(env, chatId, 'این کانال خصوصی است. لینک دعوت کانال را بفرستید (مثال: https://t.me/+AbCdEf):'); return 'keep'; }
    await Gate.set(env, userId, c.chat, null);
    await showView(env, chatId, null, await channelView(env, userId));
    return true;
  }
  if (state.action === 'cfg_link') {
    await Gate.set(env, userId, p.chat, parseLink(text));
    await showView(env, chatId, null, await channelView(env, userId));
    return true;
  }
  return false;
}

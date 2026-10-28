// Paint Shop Bot — Stage 3a: roles, admin panel, categories (single file, no dependencies).
// Bindings/secrets: DB (D1), BOT_TOKEN, WEBHOOK_SECRET, OWNER_TELEGRAM_ID, SETUP_KEY

const MAX_BODY_BYTES = 64 * 1024;
const STATE_TTL_MS = 30 * 60 * 1000;
const MAX_CATEGORY_DEPTH = 3;

// ───────────────────────── utilities ─────────────────────────
class UserError extends Error {}

function safeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

async function tg(env, method, payload) {
  // Never log the URL: it contains the bot token.
  const res = await fetch(`https://api.telegram.org/bot${env.BOT_TOKEN}/${method}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  });
  return res.json();
}

function cleanName(input) {
  const name = String(input ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim();
  if (name.length < 1) throw new UserError('نام نمی‌تواند خالی باشد.');
  if (name.length > 60) throw new UserError('نام حداکثر ۶۰ کاراکتر می‌تواند باشد.');
  return name;
}

// ───────────────────────── access control ─────────────────────────
const ROLE_PERMS = {
  admin: ['catalog.manage', 'price.manage', 'stock.manage', 'orders.manage', 'payments.review', 'reports.view'],
  operator: ['orders.manage'],
};
const ALL_PERMS = [...ROLE_PERMS.admin, 'admins.manage', 'settings.manage'];

function isOwner(env, userId) {
  return env.OWNER_TELEGRAM_ID != null && String(userId) === String(env.OWNER_TELEGRAM_ID);
}

// Real permission lookup. Called on EVERY sensitive action (hiding buttons is not security).
async function getAccess(env, userId) {
  if (isOwner(env, userId)) return { role: 'owner', has: () => true };
  const row = await env.DB.prepare(
    'SELECT role, extra_permissions FROM admins WHERE telegram_id = ?1 AND is_active = 1'
  ).bind(userId).first();
  if (!row) return null;
  let extra = [];
  try { extra = JSON.parse(row.extra_permissions); } catch { /* ignore bad JSON */ }
  const set = new Set([...(ROLE_PERMS[row.role] ?? []), ...extra.filter((p) => ALL_PERMS.includes(p))]);
  return { role: row.role, has: (p) => set.has(p) };
}

async function requirePerm(env, userId, perm) {
  const access = await getAccess(env, userId);
  if (!access || !access.has(perm)) throw new UserError('شما دسترسی لازم برای این کار را ندارید.');
  return access;
}

// ───────────────────────── core: categories (no Telegram here) ─────────────────────────
const Categories = {
  async get(env, id) {
    return env.DB.prepare('SELECT * FROM categories WHERE id = ?1').bind(id).first();
  },
  async children(env, parentId, { onlyActive = false } = {}) {
    const sql = `SELECT * FROM categories WHERE parent_id IS ?1 ${onlyActive ? 'AND is_active = 1' : ''} ORDER BY sort_order, id`;
    return (await env.DB.prepare(sql).bind(parentId).all()).results;
  },
  async depth(env, id) {
    let depth = 0, cur = id;
    while (cur != null && depth < 10) {
      const row = await Categories.get(env, cur);
      if (!row) break;
      depth++; cur = row.parent_id;
    }
    return depth;
  },
  async audit(env, actor, action, target, detail) {
    await env.DB.prepare('INSERT INTO audit_logs (actor_telegram_id, action, target, detail) VALUES (?1, ?2, ?3, ?4)')
      .bind(actor, action, String(target), detail ?? null).run();
  },
  async create(env, actor, { parentId, name }) {
    await requirePerm(env, actor, 'catalog.manage');
    const clean = cleanName(name);
    if (parentId != null) {
      const parent = await Categories.get(env, parentId);
      if (!parent) throw new UserError('دسته‌ی والد پیدا نشد.');
      if ((await Categories.depth(env, parentId)) >= MAX_CATEGORY_DEPTH) throw new UserError('حداکثر ۳ سطح دسته‌بندی مجاز است.');
    }
    const max = await env.DB.prepare('SELECT COALESCE(MAX(sort_order), 0) AS m FROM categories WHERE parent_id IS ?1').bind(parentId).first();
    const res = await env.DB.prepare('INSERT INTO categories (parent_id, name, sort_order) VALUES (?1, ?2, ?3)')
      .bind(parentId, clean, max.m + 1).run();
    const id = res.meta?.last_row_id;
    await Categories.audit(env, actor, 'category.create', id, clean);
    return id;
  },
  async rename(env, actor, id, name) {
    await requirePerm(env, actor, 'catalog.manage');
    const clean = cleanName(name);
    const res = await env.DB.prepare('UPDATE categories SET name = ?1 WHERE id = ?2').bind(clean, id).run();
    if (!res.meta?.changes) throw new UserError('دسته پیدا نشد.');
    await Categories.audit(env, actor, 'category.rename', id, clean);
  },
  async toggle(env, actor, id) {
    await requirePerm(env, actor, 'catalog.manage');
    const res = await env.DB.prepare('UPDATE categories SET is_active = 1 - is_active WHERE id = ?1').bind(id).run();
    if (!res.meta?.changes) throw new UserError('دسته پیدا نشد.');
    const row = await Categories.get(env, id);
    await Categories.audit(env, actor, 'category.toggle', id, row.is_active ? 'active' : 'inactive');
    return row.is_active === 1;
  },
  async move(env, actor, id, dir) {
    await requirePerm(env, actor, 'catalog.manage');
    const cat = await Categories.get(env, id);
    if (!cat) throw new UserError('دسته پیدا نشد.');
    const siblings = (await Categories.children(env, cat.parent_id)).map((c) => c.id);
    const i = siblings.indexOf(id), j = dir === 'up' ? i - 1 : i + 1;
    if (j < 0 || j >= siblings.length) return false;
    [siblings[i], siblings[j]] = [siblings[j], siblings[i]];
    await env.DB.batch(siblings.map((sid, idx) =>
      env.DB.prepare('UPDATE categories SET sort_order = ?1 WHERE id = ?2').bind(idx + 1, sid)));
    await Categories.audit(env, actor, 'category.move', id, dir);
    return true;
  },
};

// ───────────────────────── conversation state ─────────────────────────
const State = {
  async set(env, userId, action, payload) {
    await env.DB.prepare(
      `INSERT INTO conversation_state (telegram_id, action, payload, updated_at) VALUES (?1, ?2, ?3, datetime('now'))
       ON CONFLICT(telegram_id) DO UPDATE SET action = ?2, payload = ?3, updated_at = datetime('now')`
    ).bind(userId, action, JSON.stringify(payload ?? {})).run();
  },
  async get(env, userId) {
    const row = await env.DB.prepare('SELECT action, payload, updated_at FROM conversation_state WHERE telegram_id = ?1').bind(userId).first();
    if (!row) return null;
    const age = Date.now() - Date.parse(row.updated_at.replace(' ', 'T') + 'Z');
    if (!(age < STATE_TTL_MS)) { await State.clear(env, userId); return null; }
    let payload = {};
    try { payload = JSON.parse(row.payload); } catch { /* ignore */ }
    return { action: row.action, payload };
  },
  async clear(env, userId) {
    await env.DB.prepare('DELETE FROM conversation_state WHERE telegram_id = ?1').bind(userId).run();
  },
};

// ───────────────────────── views (Telegram rendering) ─────────────────────────
const btn = (text, data) => ({ text, callback_data: data });
const statusIcon = (c) => (c.is_active ? '✅' : '⛔');

function customerHome(env, isStaff) {
  const rows = [[btn('🛍 دسته‌بندی محصولات', 'c:l:0')]];
  if (isStaff) rows.push([btn('⚙️ پنل مدیریت', 'adm:menu')]);
  return { text: 'به فروشگاه رنگ خوش آمدید. یکی از گزینه‌ها را انتخاب کنید:', keyboard: rows };
}

async function customerCategoryView(env, parentId) {
  const parent = parentId ? await Categories.get(env, parentId) : null;
  if (parentId && (!parent || !parent.is_active)) return { text: 'این دسته در دسترس نیست.', keyboard: [[btn('🔙 دسته‌ها', 'c:l:0')]] };
  const kids = await Categories.children(env, parentId || null, { onlyActive: true });
  const rows = kids.map((c) => [btn(c.name, `c:l:${c.id}`)]);
  rows.push([btn(parent ? '🔙 بازگشت' : '🏠 منوی اصلی', parent ? `c:l:${parent.parent_id ?? 0}` : 'c:home')]);
  const text = kids.length ? (parent ? `دسته: ${parent.name}` : 'دسته‌بندی محصولات:')
    : (parent ? `دسته: ${parent.name}\nهنوز محصولی در این دسته ثبت نشده است.` : 'هنوز دسته‌ای ثبت نشده است.');
  return { text, keyboard: rows };
}

async function adminMenuView(env, userId) {
  const access = await getAccess(env, userId);
  if (!access) throw new UserError('شما دسترسی مدیریتی ندارید.');
  const rows = [];
  if (access.has('catalog.manage')) rows.push([btn('📂 دسته‌بندی‌ها', 'cat:l:0')]);
  rows.push([btn('🏠 منوی اصلی', 'c:home')]);
  const text = rows.length > 1 ? 'پنل مدیریت:' : 'پنل مدیریت:\nفعلاً بخشی برای نقش شما فعال نیست.';
  return { text, keyboard: rows };
}

async function adminCategoryList(env, userId, parentId) {
  await requirePerm(env, userId, 'catalog.manage');
  const parent = parentId ? await Categories.get(env, parentId) : null;
  const kids = await Categories.children(env, parentId || null);
  const rows = kids.map((c) => [btn(`${statusIcon(c)} ${c.name}`, `cat:v:${c.id}`)]);
  rows.push([btn('➕ دسته جدید', `cat:n:${parentId || 0}`)]);
  rows.push([btn('🔙 بازگشت', parent ? (parent.parent_id ? `cat:l:${parent.parent_id}` : 'cat:l:0') : 'adm:menu')]);
  const title = parent ? `زیرمجموعه‌های «${parent.name}»` : 'دسته‌بندی‌ها';
  return { text: kids.length ? `${title}:\n(✅ فعال، ⛔ غیرفعال)` : `${title}: هنوز چیزی ثبت نشده است.`, keyboard: rows };
}

async function adminCategoryDetail(env, userId, id) {
  await requirePerm(env, userId, 'catalog.manage');
  const c = await Categories.get(env, id);
  if (!c) throw new UserError('دسته پیدا نشد.');
  const kids = await Categories.children(env, id);
  return {
    text: `دسته: ${c.name}\nوضعیت: ${c.is_active ? 'فعال (برای مشتری نمایش داده می‌شود)' : 'غیرفعال (برای مشتری مخفی است)'}\nتعداد زیرمجموعه: ${kids.length}`,
    keyboard: [
      [btn('✏️ ویرایش نام', `cat:r:${id}`), btn(c.is_active ? '⛔ غیرفعال کن' : '✅ فعال کن', `cat:t:${id}`)],
      [btn('⬆️ بالا', `cat:u:${id}`), btn('⬇️ پایین', `cat:d:${id}`)],
      [btn('📂 زیرمجموعه‌ها', `cat:l:${id}`)],
      [btn('🔙 بازگشت', `cat:l:${c.parent_id ?? 0}`)],
    ],
  };
}

// ───────────────────────── Telegram plumbing ─────────────────────────
async function showView(env, chatId, messageId, view) {
  const reply_markup = { inline_keyboard: view.keyboard };
  if (messageId) {
    const r = await tg(env, 'editMessageText', { chat_id: chatId, message_id: messageId, text: view.text, reply_markup });
    if (r.ok || /not modified/i.test(r.description ?? '')) return;
  }
  await tg(env, 'sendMessage', { chat_id: chatId, text: view.text, reply_markup });
}

async function say(env, chatId, text) {
  await tg(env, 'sendMessage', { chat_id: chatId, text });
}

async function upsertUser(env, from) {
  await env.DB.prepare(
    `INSERT INTO users (telegram_id, first_name, username) VALUES (?1, ?2, ?3)
     ON CONFLICT(telegram_id) DO UPDATE SET first_name = ?2, username = ?3`
  ).bind(from.id, from.first_name ?? null, from.username ?? null).run();
}

async function handleMessage(env, msg) {
  if (!msg.from || msg.chat?.type !== 'private') return;
  const userId = msg.from.id, chatId = msg.chat.id;
  await upsertUser(env, msg.from);
  const text = (msg.text ?? '').trim();

  try {
    if (text === '/start' || text.startsWith('/start ')) {
      await State.clear(env, userId);
      const staff = !!(await getAccess(env, userId));
      const view = customerHome(env, staff);
      await showView(env, chatId, null, { ...view, text: `سلام ${msg.from.first_name ?? ''} 👋\n${view.text}` });
      return;
    }
    if (text === '/admin') {
      await showView(env, chatId, null, await adminMenuView(env, userId));
      return;
    }
    if (text === '/cancel') {
      await State.clear(env, userId);
      await say(env, chatId, 'عملیات لغو شد.');
      return;
    }
    const state = await State.get(env, userId);
    if (!state || text.startsWith('/')) return;

    if (state.action === 'cat_new') {
      const parentId = state.payload.parentId || null;
      const id = await Categories.create(env, userId, { parentId, name: text });
      await State.clear(env, userId);
      await showView(env, chatId, null, await adminCategoryDetail(env, userId, id));
    } else if (state.action === 'cat_rename') {
      await Categories.rename(env, userId, state.payload.id, text);
      await State.clear(env, userId);
      await showView(env, chatId, null, await adminCategoryDetail(env, userId, state.payload.id));
    }
  } catch (err) {
    if (err instanceof UserError) { await say(env, chatId, `⚠️ ${err.message}`); return; }
    throw err;
  }
}

async function handleCallback(env, cq) {
  const chat = cq.message?.chat, messageId = cq.message?.message_id;
  const userId = cq.from?.id;
  const answer = (text) => tg(env, 'answerCallbackQuery', { callback_query_id: cq.id, ...(text ? { text, show_alert: true } : {}) });
  if (!chat || chat.type !== 'private' || !userId || typeof cq.data !== 'string' || cq.data.length > 64) return answer();

  const [ns, action, arg] = cq.data.split(':');
  const id = Number(arg);
  try {
    let view = null;
    if (ns === 'c') {
      if (action === 'home') view = customerHome(env, !!(await getAccess(env, userId)));
      else if (action === 'l' && Number.isInteger(id) && id >= 0) view = await customerCategoryView(env, id);
    } else if (ns === 'adm' && action === 'menu') {
      view = await adminMenuView(env, userId);
    } else if (ns === 'cat' && Number.isInteger(id) && id >= 0) {
      await requirePerm(env, userId, 'catalog.manage');
      if (action === 'l') view = await adminCategoryList(env, userId, id);
      else if (action === 'v') view = await adminCategoryDetail(env, userId, id);
      else if (action === 't') { await Categories.toggle(env, userId, id); view = await adminCategoryDetail(env, userId, id); }
      else if (action === 'u' || action === 'd') { await Categories.move(env, userId, id, action === 'u' ? 'up' : 'down'); view = await adminCategoryDetail(env, userId, id); }
      else if (action === 'n') {
        await State.set(env, userId, 'cat_new', { parentId: id });
        await answer();
        await say(env, chat.id, 'نام دسته‌ی جدید را بفرستید (برای لغو: /cancel):');
        return;
      } else if (action === 'r') {
        if (!(await Categories.get(env, id))) throw new UserError('دسته پیدا نشد.');
        await State.set(env, userId, 'cat_rename', { id });
        await answer();
        await say(env, chat.id, 'نام جدید را بفرستید (برای لغو: /cancel):');
        return;
      }
    }
    await answer();
    if (view) await showView(env, chat.id, messageId, view);
  } catch (err) {
    if (err instanceof UserError) { await answer(err.message); return; }
    throw err;
  }
}

// ───────────────────────── HTTP entry ─────────────────────────
async function handleWebhook(request, env) {
  if (request.method !== 'POST') return new Response('method not allowed', { status: 405 });
  const secret = request.headers.get('X-Telegram-Bot-Api-Secret-Token');
  if (!safeEqual(secret ?? '', env.WEBHOOK_SECRET ?? '#')) return new Response('forbidden', { status: 403 });

  const raw = await request.text();
  if (raw.length > MAX_BODY_BYTES) return new Response('too large', { status: 413 });
  let update;
  try { update = JSON.parse(raw); } catch { return new Response('bad request', { status: 400 }); }
  if (!Number.isSafeInteger(update?.update_id)) return new Response('bad request', { status: 400 });

  // Telegram retries on non-200: process each update_id once.
  const seen = await env.DB.prepare('INSERT OR IGNORE INTO processed_updates (update_id) VALUES (?1)')
    .bind(update.update_id).run();
  if (!seen.meta?.changes) return new Response('ok');

  try {
    if (update.message) await handleMessage(env, update.message);
    else if (update.callback_query) await handleCallback(env, update.callback_query);
  } catch (err) {
    console.error('handler error:', err?.message ?? 'unknown'); // message only, no request data
  }
  return new Response('ok');
}

async function handleSetup(url, env) {
  if (!safeEqual(url.searchParams.get('key') ?? '', env.SETUP_KEY ?? '#')) return new Response('forbidden', { status: 403 });
  const result = await tg(env, 'setWebhook', {
    url: `${url.origin}/webhook`,
    secret_token: env.WEBHOOK_SECRET,
    allowed_updates: ['message', 'callback_query'],
    drop_pending_updates: true,
  });
  return Response.json({ ok: result.ok === true, description: result.description ?? null });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    try {
      if (url.pathname === '/health') {
        await env.DB.prepare('SELECT 1').first();
        return new Response('ok');
      }
      if (url.pathname === '/webhook') return await handleWebhook(request, env);
      if (url.pathname === '/setup') return await handleSetup(url, env);
      return new Response('not found', { status: 404 });
    } catch (err) {
      console.error('unhandled error:', err?.message ?? 'unknown');
      return new Response('internal error', { status: 500 });
    }
  },
};

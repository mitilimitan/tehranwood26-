// Paint Shop Bot — Stage 2 skeleton (single file, no dependencies).
// Bindings/secrets required: DB (D1), BOT_TOKEN, WEBHOOK_SECRET, OWNER_TELEGRAM_ID, SETUP_KEY

const MAX_BODY_BYTES = 64 * 1024;

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

async function upsertUser(env, from) {
  await env.DB.prepare(
    `INSERT INTO users (telegram_id, first_name, username) VALUES (?1, ?2, ?3)
     ON CONFLICT(telegram_id) DO UPDATE SET first_name = ?2, username = ?3`
  ).bind(from.id, from.first_name ?? null, from.username ?? null).run();
}

function isOwner(env, userId) {
  return String(userId) === String(env.OWNER_TELEGRAM_ID);
}

async function handleMessage(env, msg) {
  if (!msg.from || msg.chat?.type !== 'private') return;
  await upsertUser(env, msg.from);
  const text = (msg.text ?? '').trim();
  if (text === '/start' || text.startsWith('/start ')) {
    const role = isOwner(env, msg.from.id) ? '\n\n(شما به‌عنوان «مالک» فروشگاه شناسایی شدید.)' : '';
    await tg(env, 'sendMessage', {
      chat_id: msg.chat.id,
      text: `سلام ${msg.from.first_name ?? ''} 👋\nبه فروشگاه رنگ خوش آمدید.\nراه‌اندازی ربات در حال انجام است؛ به‌زودی کاتالوگ محصولات اینجا نمایش داده می‌شود.${role}`,
    });
  }
}

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

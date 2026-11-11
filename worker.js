// Paint Shop Bot — entry point (split into small modules so it can be pasted on a phone).
import { handleCallback } from './callbacks.js';
import { MAX_BODY_BYTES, safeEqual, tg } from './core.js';
import { handleMessage } from './flows.js';
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

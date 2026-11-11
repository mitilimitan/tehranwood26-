import { BROWSE_PERMS, MAX_BULK_ITEMS, MAX_IMAGES_PER_PRODUCT, PAGE_SIZE, UserError, clip, currencyLabel, fmt, getAccess, requireAnyPerm, requirePerm, tg } from './core.js';
import { BulkPrice, Variants } from './stock.js';
import { ProductImages, Products, available, weightOf } from './store.js';
import { btn } from './views_a.js';
export async function adminProductList(env, userId, page) {
  await requireAnyPerm(env, userId, BROWSE_PERMS);
  const access = await getAccess(env, userId);
  const { total, rows } = await Products.page(env, page);
  const kb = rows.map((p) => [btn(`${p.is_published ? '✅' : '📝'} ${p.name}`, `prd:v:${p.id}`)]);
  const nav = [];
  if (page > 0) nav.push(btn('⬅️ قبلی', `prd:l:${page - 1}`));
  if ((page + 1) * PAGE_SIZE < total) nav.push(btn('بعدی ➡️', `prd:l:${page + 1}`));
  if (nav.length) kb.push(nav);
  if (access.has('catalog.manage')) kb.push([btn('➕ محصول جدید', 'prd:n')]);
  kb.push([btn('🔙 بازگشت', 'adm:menu')]);
  return { text: total ? `محصولات (${fmt(total)}):\n(✅ منتشرشده، 📝 پیش‌نویس)` : 'هنوز محصولی ثبت نشده است.', keyboard: kb };
}
export async function adminProductDetail(env, userId, pid) {
  const access = await requireAnyPerm(env, userId, BROWSE_PERMS);
  const p = await Products.get(env, pid);
  if (!p) throw new UserError('محصول پیدا نشد.');
  const cur = await currencyLabel(env);
  const cats = await Products.categories(env, pid);
  const vars = await Products.variants(env, pid);
  const specs = Object.entries(Products.specs(p));
  const imageCount = (await ProductImages.list(env, pid)).length;
  const lines = [`📦 ${p.name}`, `برند: ${p.brand ?? '—'}`, `وضعیت: ${p.is_published ? 'منتشرشده (برای مشتری نمایش داده می‌شود)' : 'پیش‌نویس (برای مشتری مخفی است)'}`,
    `دسته‌ها: ${cats.length ? cats.map((c) => c.name).join('، ') : '—'}`, `عکس‌ها: ${fmt(imageCount)}`, `توضیحات: ${p.description ?? '—'}`, '', 'مشخصات:'];
  lines.push(...(specs.length ? specs.map(([k, v]) => `• ${k}: ${v}`) : ['—']));
  lines.push('', 'بسته‌بندی‌ها:');
  if (!vars.length) lines.push('—');
  for (const v of vars) {
    lines.push(`• ${v.label} | کد ${v.sku} | ${fmt(v.price)} ${cur} | موجودی ${fmt(v.stock_on_hand)} (رزرو ${fmt(v.stock_reserved)}) ${v.is_active ? '' : '| ⛔ غیرفعال '}${v.is_sellable ? '' : '| 🚫 ناموجود موقت'}`);
  }
  const kb = vars.map((v) => [btn(`${v.is_active ? '📦' : '⛔'} ${v.label}`, `var:v:${v.id}`)]);
  if (access.has('catalog.manage')) {
    kb.push([btn('✏️ نام', `prd:e:${pid}:name`), btn('✏️ برند', `prd:e:${pid}:brand`), btn('✏️ توضیحات', `prd:e:${pid}:description`)]);
    kb.push([btn('➕ مشخصه', `prd:s:${pid}`), btn('🧹 پاک کردن مشخصات', `prd:sc:${pid}`)]);
    kb.push([btn('📂 دسته‌های محصول', `prd:c:${pid}`), btn(`📷 عکس‌ها (${fmt(imageCount)})`, `prd:im:${pid}`)]);
    kb.push([btn(p.is_published ? '📝 برگردان به پیش‌نویس' : '✅ انتشار', `prd:p:${pid}`)]);
  }
  if (['catalog.manage', 'price.manage', 'stock.manage'].every((x) => access.has(x))) kb.push([btn('➕ بسته‌بندی جدید', `prd:vn:${pid}`)]);
  kb.push([btn('🔙 بازگشت', 'prd:l:0')]);
  return { text: clip(lines.join('\n')), keyboard: kb };
}
export async function adminImagesView(env, userId, pid) {
  const access = await requireAnyPerm(env, userId, BROWSE_PERMS);
  const p = await Products.get(env, pid);
  if (!p) throw new UserError('محصول پیدا نشد.');
  const imgs = await ProductImages.list(env, pid);
  const kb = [];
  if (imgs.length) kb.push([btn('👁 نمایش عکس‌ها', `prd:iv:${pid}`)]);
  if (access.has('catalog.manage')) {
    imgs.forEach((im, i) => kb.push([btn(`🗑 حذف عکس ${fmt(i + 1)}`, `img:rm:${im.id}`), ...(i > 0 ? [btn(`⭐ عکس ${fmt(i + 1)} را اصلی کن`, `img:pr:${im.id}`)] : [])]));
    if (imgs.length < MAX_IMAGES_PER_PRODUCT) kb.push([btn('➕ افزودن عکس', `prd:ia:${pid}`)]);
  }
  kb.push([btn('🔙 بازگشت', `prd:v:${pid}`)]);
  return { text: `📷 عکس‌های «${p.name}»: ${fmt(imgs.length)} از ${fmt(MAX_IMAGES_PER_PRODUCT)}\nعکس اول، عکس اصلی است.`, keyboard: kb };
}
export async function adminProductCategories(env, userId, pid) {
  await requirePerm(env, userId, 'catalog.manage');
  const p = await Products.get(env, pid);
  if (!p) throw new UserError('محصول پیدا نشد.');
  const linked = new Set((await Products.categories(env, pid)).map((c) => c.id));
  const all = (await env.DB.prepare('SELECT id, name, parent_id FROM categories ORDER BY parent_id IS NOT NULL, parent_id, sort_order, id LIMIT 40').all()).results;
  const kb = all.map((c) => [btn(`${linked.has(c.id) ? '☑️' : '⬜'} ${c.parent_id ? '↳ ' : ''}${c.name}`, `prd:ct:${pid}:${c.id}`)]);
  kb.push([btn('🔙 بازگشت', `prd:v:${pid}`)]);
  return { text: all.length ? `دسته‌های «${p.name}» را انتخاب کنید (لمس = افزودن/حذف):` : 'ابتدا از «دسته‌بندی‌ها» یک دسته بسازید.', keyboard: kb };
}
export async function adminVariantDetail(env, userId, vid) {
  const access = await requireAnyPerm(env, userId, BROWSE_PERMS);
  const v = await Variants.get(env, vid);
  if (!v) throw new UserError('بسته‌بندی پیدا نشد.');
  const p = await Products.get(env, v.product_id);
  const cur = await currencyLabel(env);
  const w = weightOf(v);
  const text = [`📦 ${p.name} — ${v.label}`, `کد کالا: ${v.sku}`, `قیمت: ${fmt(v.price)} ${cur}`, `موجودی فیزیکی: ${fmt(v.stock_on_hand)}`,
    `رزرو شده: ${fmt(v.stock_reserved)}`, `قابل فروش: ${fmt(available(v))}`, `وضعیت فروش: ${v.is_sellable ? 'فعال' : '🚫 موقتاً ناموجود'}`,
    `وضعیت: ${v.is_active ? 'فعال' : '⛔ غیرفعال (برای مشتری مخفی)'}`, `وزن: ${w ? fmt(w) + ' کیلوگرم' : '—'}`].join('\n');
  const kb = [];
  if (access.has('price.manage')) kb.push([btn('💲 تغییر قیمت', `var:pr:${vid}`)]);
  if (access.has('stock.manage')) {
    kb.push([btn('➕ افزایش موجودی', `var:st:${vid}:add`), btn('➖ کاهش', `var:st:${vid}:sub`)]);
    kb.push([btn('🔢 تنظیم مقدار موجودی', `var:st:${vid}:set`), btn(v.is_sellable ? '🚫 ناموجود موقت' : '✅ فروش مجدد', `var:sl:${vid}`)]);
  }
  if (access.has('catalog.manage')) kb.push([btn('✏️ نام بسته‌بندی', `var:rn:${vid}`), btn(v.is_active ? '⛔ غیرفعال کن' : '✅ فعال کن', `var:ac:${vid}`)]);
  kb.push([btn('🧾 سابقه قیمت و موجودی', `var:h:${vid}`)]);
  kb.push([btn('🔙 بازگشت', `prd:v:${v.product_id}`)]);
  return { text, keyboard: kb };
}
export async function adminVariantHistory(env, userId, vid) {
  await requireAnyPerm(env, userId, BROWSE_PERMS);
  const v = await Variants.get(env, vid);
  if (!v) throw new UserError('بسته‌بندی پیدا نشد.');
  const h = await Variants.history(env, vid);
  const lines = [`🧾 سابقه «${v.label}»`, '', 'آخرین تغییرات موجودی:'];
  lines.push(...(h.moves.length ? h.moves.map((m) => `• ${m.delta_on_hand > 0 ? '+' : ''}${fmt(m.delta_on_hand)} — ${m.note ?? m.reason} (${m.created_at})`) : ['—']));
  lines.push('', 'آخرین تغییرات قیمت:');
  lines.push(...(h.prices.length ? h.prices.map((x) => `• ${fmt(x.old_price)} ← ${fmt(x.new_price)} (${x.created_at})`) : ['—']));
  return { text: lines.join('\n'), keyboard: [[btn('🔙 بازگشت', `var:v:${vid}`)]] };
}
export async function bulkMenuView(env, userId) {
  await requirePerm(env, userId, 'price.manage');
  const cats = (await env.DB.prepare('SELECT id, name, parent_id FROM categories ORDER BY parent_id IS NOT NULL, parent_id, sort_order, id LIMIT 40').all()).results;
  const kb = [[btn('🌐 همه‌ی محصولات', 'bp:s:0')]];
  for (const c of cats) kb.push([btn(`${c.parent_id ? '↳ ' : ''}${c.name}`, `bp:s:${c.id}`)]);
  kb.push([btn('🔙 بازگشت', 'adm:menu')]);
  return { text: `تغییر درصدی قیمت: ابتدا محدوده را انتخاب کنید.\n(برای یک دسته، زیرمجموعه‌هایش هم شامل می‌شوند. حداکثر ${fmt(MAX_BULK_ITEMS)} بسته‌بندی در هر عملیات.)`, keyboard: kb };
}
export async function bulkPreviewView(env, items, pct) {
  const cur = await currencyLabel(env);
  const sample = items.slice(0, 8).map((i) => `• ${i.name} — ${i.label}: ${fmt(i.old)} ← ${fmt(i.next)}`);
  const more = items.length > sample.length ? [`… و ${fmt(items.length - sample.length)} مورد دیگر`] : [];
  return {
    text: clip([`پیش‌نمایش تغییر ${pct > 0 ? '+' : ''}${fmt(pct)}٪ (گرد شده به ${fmt(BulkPrice.roundStep)} ${cur})`, `تعداد بسته‌بندی‌های تغییرکننده: ${fmt(items.length)}`, '', ...sample, ...more, '', 'تأیید می‌کنید؟'].join('\n')),
    keyboard: [[btn('✅ تأیید و اعمال', 'bp:ok'), btn('❌ انصراف', 'bp:no')]],
  };
}
// ───────────────────────── Telegram plumbing ─────────────────────────
export const CANCEL_HINT = '\n(برای لغو: /cancel)';

export async function showView(env, chatId, messageId, view) {
  const reply_markup = { inline_keyboard: view.keyboard };
  if (messageId) {
    const r = await tg(env, 'editMessageText', { chat_id: chatId, message_id: messageId, text: view.text, reply_markup });
    if (r.ok || /not modified/i.test(r.description ?? '')) return;
  }
  await tg(env, 'sendMessage', { chat_id: chatId, text: view.text, reply_markup });
}

export async function say(env, chatId, text) {
  await tg(env, 'sendMessage', { chat_id: chatId, text });
}

// Sends product photos; never throws (a broken file_id must not block the text).
export async function sendProductPhotos(env, chatId, pid) {
  try {
    const imgs = (await ProductImages.list(env, pid)).slice(0, 10);
    if (imgs.length === 1) await tg(env, 'sendPhoto', { chat_id: chatId, photo: imgs[0].telegram_file_id });
    else if (imgs.length > 1) await tg(env, 'sendMediaGroup', { chat_id: chatId, media: imgs.map((i) => ({ type: 'photo', media: i.telegram_file_id })) });
    return imgs.length;
  } catch (err) {
    console.error('photo send failed:', err?.message ?? 'unknown');
    return 0;
  }
}

export async function upsertUser(env, from) {
  await env.DB.prepare(
    `INSERT INTO users (telegram_id, first_name, username) VALUES (?1, ?2, ?3)
     ON CONFLICT(telegram_id) DO UPDATE SET first_name = ?2, username = ?3`
  ).bind(from.id, from.first_name ?? null, from.username ?? null).run();
}

// ── typed answers for multi-step flows

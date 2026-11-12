import { BROWSE_PERMS, Categories, UserError, clip, currencyLabel, fmt, getAccess, isOwner, personLabel, requireOwner, requirePerm, tg } from './core.js';
import { Orders } from './orders.js';
import { Admins, Products, isBuyable, weightOf } from './store.js';
export const btn = (text, data) => ({ text, callback_data: data });
export const statusIcon = (c) => (c.is_active ? '✅' : '⛔');
export const onOff = (b, a, c) => (b ? a : c);

export function customerHome(env, isStaff) {
  const rows = [[btn('🛍 دسته‌بندی محصولات', 'c:l:0')], [btn('🧺 سبد خرید', 'k:v'), btn('📦 سفارش‌های من', 'o:l')]];
  if (isStaff) rows.push([btn('⚙️ پنل مدیریت', 'adm:menu')]);
  return { text: 'به فروشگاه رنگ خوش آمدید. یکی از گزینه‌ها را انتخاب کنید:', keyboard: rows };
}

export async function customerCategoryView(env, parentId) {
  const parent = parentId ? await Categories.get(env, parentId) : null;
  if (parentId && (!parent || !parent.is_active)) return { text: 'این دسته در دسترس نیست.', keyboard: [[btn('🔙 دسته‌ها', 'c:l:0')]] };
  const kids = await Categories.children(env, parentId || null, { onlyActive: true });
  const prods = parentId ? await Products.publishedInCategory(env, parentId) : [];
  const rows = kids.map((c) => [btn(c.name, `c:l:${c.id}`)]);
  for (const p of prods) rows.push([btn(`🎨 ${p.name}`, `c:p:${p.id}:${parentId}`)]);
  rows.push([btn(parent ? '🔙 بازگشت' : '🏠 منوی اصلی', parent ? `c:l:${parent.parent_id ?? 0}` : 'c:home')]);
  let text;
  if (!kids.length && !prods.length) text = parent ? `دسته: ${parent.name}\nهنوز محصولی در این دسته ثبت نشده است.` : 'هنوز دسته‌ای ثبت نشده است.';
  else text = parent ? `دسته: ${parent.name}` : 'دسته‌بندی محصولات:';
  return { text, keyboard: rows };
}

export async function customerProductView(env, pid, cid) {
  await Orders.expireDue(env);
  const p = await Products.get(env, pid);
  const back = [[btn('🔙 بازگشت', `c:l:${cid || 0}`)]];
  if (!p || !p.is_published) return { text: 'این محصول در دسترس نیست.', keyboard: back };
  const cur = await currencyLabel(env);
  const specs = Object.entries(Products.specs(p));
  const vars = await Products.variants(env, pid, { onlyActive: true });
  const lines = [`🎨 ${p.name}`];
  if (p.brand) lines.push(`برند: ${p.brand}`);
  if (p.description) lines.push('', p.description);
  if (specs.length) lines.push('', 'مشخصات:', ...specs.map(([k, v]) => `• ${k}: ${v}`));
  lines.push('', 'بسته‌بندی‌ها:');
  if (!vars.length) lines.push('هنوز بسته‌بندی‌ای ثبت نشده است.');
  for (const v of vars) {
    const w = weightOf(v);
    lines.push(`• ${v.label}${w ? ` (وزن: ${fmt(w)} کیلوگرم)` : ''} — ${fmt(v.price)} ${cur} — ${isBuyable(v) ? '✅ موجود' : '❌ ناموجود'}`);
  }
  const rows = [];
  if (p.is_published) for (const v of vars) if (isBuyable(v)) rows.push([btn(`🧺 افزودن به سبد: ${v.label}`.slice(0, 60), `k:add:${v.id}`)]);
  rows.push([btn('🧺 سبد خرید', 'k:v')], ...back);
  return { text: clip(lines.join('\n')), keyboard: rows };
}

export async function adminMenuView(env, userId) {
  const access = await getAccess(env, userId);
  if (!access) throw new UserError('شما دسترسی مدیریتی ندارید.');
  const rows = [];
  if (access.has('catalog.manage')) rows.push([btn('📂 دسته‌بندی‌ها', 'cat:l:0')]);
  if (BROWSE_PERMS.some((p) => access.has(p))) rows.push([btn('🛒 محصولات و قیمت و موجودی', 'prd:l:0')]);
  if (access.has('price.manage')) rows.push([btn('💲 تغییر درصدی قیمت‌ها', 'bp:menu')]);
  if (access.has('orders.manage')) rows.push([btn('📦 سفارش‌ها', 'ao:l')]);
  if (access.has('payments.review')) rows.push([btn('💳 بررسی رسیدها', 'ao:rv'), btn('⚙️ شماره کارت', 'set:card')]);
  if (access.role === 'owner') rows.push([btn('👥 مدیریت ادمین‌ها', 'adm:list')]);
  const empty = rows.length === 0;
  rows.push([btn('🏠 منوی اصلی', 'c:home')]);
  return { text: empty ? 'پنل مدیریت:\nفعلاً بخشی برای نقش شما فعال نیست.' : 'پنل مدیریت:', keyboard: rows };
}

// ── admin management views
export async function adminListView(env, userId) {
  requireOwner(env, userId);
  const list = await Admins.list(env);
  const rows = list.map((a) => [btn(`${a.is_active ? '✅' : '⛔'} ${a.role === 'admin' ? 'ادمین' : 'اپراتور'} — ${personLabel(a)}`, `adm:v:${a.telegram_id}`)]);
  rows.push([btn('➕ افزودن ادمین', 'adm:add')]);
  rows.push([btn('🔙 بازگشت', 'adm:menu')]);
  return { text: list.length ? 'ادمین‌ها (مالک اصلی جداگانه است و همیشه دسترسی کامل دارد):' : 'هنوز ادمینی ثبت نشده است. مالک اصلی دسترسی کامل دارد.', keyboard: rows };
}
export async function adminAddView(env, userId) {
  requireOwner(env, userId);
  const users = await Admins.recentUsers(env);
  const rows = users.map((u) => [btn(personLabel(u), `adm:pick:${u.telegram_id}`)]);
  rows.push([btn('🔢 وارد کردن شناسه‌ی عددی', 'adm:id')]);
  rows.push([btn('🔙 بازگشت', 'adm:list')]);
  return {
    text: users.length ? 'از بین افرادی که ربات را استارت کرده‌اند، یکی را انتخاب کنید.\n(اگر فرد در لیست نیست، از او بخواهید ربات را /start کند.)'
      : 'هنوز فرد دیگری ربات را استارت نکرده است. از او بخواهید ربات را /start کند، یا شناسه‌ی عددی‌اش را وارد کنید.',
    keyboard: rows,
  };
}
export async function adminRoleChoiceView(env, userId, tgid) {
  requireOwner(env, userId);
  Admins.validateId(tgid);
  if (isOwner(env, tgid)) throw new UserError('مالک اصلی نیازی به ثبت به‌عنوان ادمین ندارد.');
  const u = (await env.DB.prepare('SELECT telegram_id, first_name, username FROM users WHERE telegram_id = ?1').bind(tgid).first()) ?? { telegram_id: tgid };
  return {
    text: `نقش «${personLabel(u)}» را انتخاب کنید:\n\n• ادمین: مدیریت دسته‌بندی، محصول، قیمت، موجودی، سفارش‌ها\n• اپراتور: فقط پردازش سفارش‌ها`,
    keyboard: [[btn('ادمین', `adm:set:${tgid}:admin`), btn('اپراتور', `adm:set:${tgid}:operator`)], [btn('🔙 بازگشت', 'adm:add')]],
  };
}
export async function adminDetailView(env, userId, tgid) {
  requireOwner(env, userId);
  const a = await Admins.get(env, tgid);
  if (!a) throw new UserError('این ادمین پیدا نشد.');
  const other = a.role === 'admin' ? 'operator' : 'admin';
  return {
    text: `${personLabel(a)}\nنقش: ${a.role === 'admin' ? 'ادمین' : 'اپراتور'}\nوضعیت: ${a.is_active ? 'فعال' : 'غیرفعال'}`,
    keyboard: [
      [btn(a.is_active ? '⛔ غیرفعال کن' : '✅ فعال کن', `adm:tg:${tgid}`)],
      [btn(`تغییر نقش به ${other === 'admin' ? 'ادمین' : 'اپراتور'}`, `adm:set:${tgid}:${other}`)],
      [btn('🔙 بازگشت', 'adm:list')],
    ],
  };
}

// ── category views (admin)
export async function adminCategoryList(env, userId, parentId) {
  await requirePerm(env, userId, 'catalog.manage');
  const parent = parentId ? await Categories.get(env, parentId) : null;
  const kids = await Categories.children(env, parentId || null);
  const rows = kids.map((c) => [btn(`${statusIcon(c)} ${c.name}`, `cat:v:${c.id}`)]);
  rows.push([btn('➕ دسته جدید', `cat:n:${parentId || 0}`)]);
  rows.push([btn('🔙 بازگشت', parent ? (parent.parent_id ? `cat:l:${parent.parent_id}` : 'cat:l:0') : 'adm:menu')]);
  const title = parent ? `زیرمجموعه‌های «${parent.name}»` : 'دسته‌بندی‌ها';
  return { text: kids.length ? `${title}:\n(✅ فعال، ⛔ غیرفعال)` : `${title}: هنوز چیزی ثبت نشده است.`, keyboard: rows };
}
export async function adminCategoryDetail(env, userId, id) {
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

// ── product views (admin)

import { BROWSE_PERMS, Categories, State, UserError, currencyLabel, fmt, getAccess, requireAnyPerm, requireOwner, requirePerm, tg } from './core.js';
import { BulkPrice, Variants } from './stock.js';
import { Admins, ProductImages, Products } from './store.js';
import { adminAddView, adminCategoryDetail, adminCategoryList, adminDetailView, adminListView, adminMenuView, adminRoleChoiceView, btn, customerCategoryView, customerHome, customerProductView } from './views_a.js';
import { Gate, handleCfgCallback, isCfgNs } from './config.js';
import { handleBroadcastCallback, isBroadcastNs } from './broadcast.js';
import { handleShopCallback, isShopNs } from './orders_cb.js';
import { handleSupportCallback, isSupportNs } from './support.js';
import { CANCEL_HINT, adminImagesView, adminProductCategories, adminProductDetail, adminProductList, adminVariantDetail, adminVariantHistory, bulkMenuView, say, sendProductPhotos, showView } from './views_b.js';
export async function handleCallback(env, cq) {
  const chat = cq.message?.chat, messageId = cq.message?.message_id;
  const userId = cq.from?.id;
  const answer = (text) => tg(env, 'answerCallbackQuery', { callback_query_id: cq.id, ...(text ? { text, show_alert: true } : {}) });
  if (!chat || chat.type !== 'private' || !userId || typeof cq.data !== 'string' || cq.data.length > 64) return answer();

  const [ns, action, a, b] = cq.data.split(':');
  const n = Number(a);
  const idOk = a !== undefined && a !== '' && Number.isInteger(n) && n >= 0;
  const ask = async (stateAction, payload, prompt) => {
    await State.set(env, userId, stateAction, payload);
    await answer();
    await say(env, chat.id, prompt + CANCEL_HINT);
  };

  try {
    const ctx = { chatId: chat.id, messageId, userId, answer, ask };
    if (isCfgNs(ns) && ns === 'gate') return await handleCfgCallback(env, cq, ctx);
    if (await Gate.blocks(env, userId, chat.id, messageId)) return answer();
    if (isShopNs(ns)) return await handleShopCallback(env, cq, ctx);
    if (isBroadcastNs(ns)) return await handleBroadcastCallback(env, cq, ctx);
    if (isSupportNs(ns)) return await handleSupportCallback(env, cq, ctx);
    if (isCfgNs(ns)) return await handleCfgCallback(env, cq, ctx);
    let view = null;
    if (ns === 'c') {
      if (action === 'home') view = customerHome(env, !!(await getAccess(env, userId)));
      else if (action === 'l' && idOk) view = await customerCategoryView(env, n);
      else if (action === 'p' && idOk) {
        view = await customerProductView(env, n, Number(b) || 0);
        const prod = await Products.get(env, n);
        if (prod?.is_published && (await sendProductPhotos(env, chat.id, n)) > 0) { await answer(); return showView(env, chat.id, null, view); }
      }
    } else if (ns === 'adm') {
      if (action === 'menu') view = await adminMenuView(env, userId);
      else if (action === 'list') view = await adminListView(env, userId);
      else if (action === 'add') view = await adminAddView(env, userId);
      else if (action === 'id') {
        requireOwner(env, userId);
        return ask('adm_add_id', {}, 'شناسه‌ی عددی تلگرام فرد را بفرستید (او می‌تواند آن را از ربات @userinfobot بگیرد).');
      } else if (idOk && n > 0) {
        if (action === 'pick') view = await adminRoleChoiceView(env, userId, n);
        else if (action === 'v') view = await adminDetailView(env, userId, n);
        else if (action === 'set') {
          await Admins.upsert(env, userId, n, b);
          try { await say(env, n, 'شما توسط مالک فروشگاه به‌عنوان مدیر ربات اضافه شدید. برای ورود به پنل بفرستید: /admin'); } catch { /* user may not have started the bot */ }
          view = await adminDetailView(env, userId, n);
        } else if (action === 'tg') {
          requireOwner(env, userId);
          const adm = await Admins.get(env, n);
          if (!adm) throw new UserError('این ادمین پیدا نشد.');
          await Admins.setActive(env, userId, n, !adm.is_active);
          view = await adminDetailView(env, userId, n);
        }
      }
    } else if (ns === 'cat' && idOk) {
      await requirePerm(env, userId, 'catalog.manage');
      if (action === 'l') view = await adminCategoryList(env, userId, n);
      else if (action === 'v') view = await adminCategoryDetail(env, userId, n);
      else if (action === 't') { await Categories.toggle(env, userId, n); view = await adminCategoryDetail(env, userId, n); }
      else if (action === 'u' || action === 'd') { await Categories.move(env, userId, n, action === 'u' ? 'up' : 'down'); view = await adminCategoryDetail(env, userId, n); }
      else if (action === 'n') return ask('cat_new', { parentId: n }, 'نام دسته‌ی جدید را بفرستید:');
      else if (action === 'r') {
        if (!(await Categories.get(env, n))) throw new UserError('دسته پیدا نشد.');
        return ask('cat_rename', { id: n }, 'نام جدید را بفرستید:');
      }
    } else if (ns === 'prd') {
      if (action === 'l' && idOk) view = await adminProductList(env, userId, n);
      else if (action === 'n') { await requirePerm(env, userId, 'catalog.manage'); return ask('prd_new', {}, 'نام محصول جدید را بفرستید:'); }
      else if (idOk && n > 0) {
        if (action === 'v') view = await adminProductDetail(env, userId, n);
        else if (action === 'e' && ['name', 'brand', 'description'].includes(b)) {
          await requirePerm(env, userId, 'catalog.manage');
          if (!(await Products.get(env, n))) throw new UserError('محصول پیدا نشد.');
          const label = { name: 'نام جدید محصول', brand: 'برند', description: 'توضیحات' }[b];
          return ask('prd_edit', { id: n, field: b }, `${label} را بفرستید${b === 'name' ? '' : ' (یا «-» برای حذف)'}:`);
        } else if (action === 's') {
          await requirePerm(env, userId, 'catalog.manage');
          if (!(await Products.get(env, n))) throw new UserError('محصول پیدا نشد.');
          return ask('prd_spec', { id: n }, 'مشخصه را به شکل «نام: مقدار» بفرستید. مثال:\nرنگ: سفید\nنوع: اکریلیک\nسطح براقیت: مات');
        } else if (action === 'sc') { await Products.clearSpecs(env, userId, n); view = await adminProductDetail(env, userId, n); }
        else if (action === 'p') { await Products.togglePublish(env, userId, n); view = await adminProductDetail(env, userId, n); }
        else if (action === 'c') view = await adminProductCategories(env, userId, n);
        else if (action === 'im') { await State.clear(env, userId); view = await adminImagesView(env, userId, n); }
        else if (action === 'iv') {
          await requireAnyPerm(env, userId, BROWSE_PERMS);
          await answer();
          if (!(await sendProductPhotos(env, chat.id, n))) await say(env, chat.id, 'عکسی ثبت نشده است.');
          return;
        } else if (action === 'ia') {
          await requirePerm(env, userId, 'catalog.manage');
          if (!(await Products.get(env, n))) throw new UserError('محصول پیدا نشد.');
          return ask('prd_photo', { id: n }, 'عکس محصول را بفرستید (به‌صورت عکس، نه فایل). می‌توانید چند عکس پشت سر هم بفرستید.');
        }
        else if (action === 'ct') { await Products.toggleCategory(env, userId, n, Number(b)); view = await adminProductCategories(env, userId, n); }
        else if (action === 'vn') {
          for (const p of ['catalog.manage', 'price.manage', 'stock.manage']) await requirePerm(env, userId, p);
          if (!(await Products.get(env, n))) throw new UserError('محصول پیدا نشد.');
          return ask('var_new', { pid: n, step: 'label' }, 'نام بسته‌بندی را بفرستید (مثلاً «۴ لیتری»):');
        }
      }
    } else if (ns === 'img' && idOk && n > 0) {
      if (action === 'rm') view = await adminImagesView(env, userId, await ProductImages.remove(env, userId, n));
      else if (action === 'pr') view = await adminImagesView(env, userId, await ProductImages.makePrimary(env, userId, n));
    } else if (ns === 'var' && idOk && n > 0) {
      if (action === 'v') view = await adminVariantDetail(env, userId, n);
      else if (action === 'h') view = await adminVariantHistory(env, userId, n);
      else if (action === 'pr') {
        await requirePerm(env, userId, 'price.manage');
        const v = await Variants.get(env, n);
        if (!v) throw new UserError('بسته‌بندی پیدا نشد.');
        const cur = await currencyLabel(env);
        return ask('var_price', { id: n }, `قیمت جدید را به ${cur} بفرستید (فقط عدد). قیمت فعلی: ${fmt(v.price)}`);
      } else if (action === 'st' && ['add', 'sub', 'set'].includes(b)) {
        await requirePerm(env, userId, 'stock.manage');
        if (!(await Variants.get(env, n))) throw new UserError('بسته‌بندی پیدا نشد.');
        const q = { add: 'تعداد افزایش', sub: 'تعداد کاهش', set: 'مقدار جدید کل موجودی' }[b];
        return ask('stock_qty', { vid: n, mode: b }, `${q} را بفرستید (عدد):`);
      } else if (action === 'sl') { await Variants.toggleSellable(env, userId, n); view = await adminVariantDetail(env, userId, n); }
      else if (action === 'ac') { await Variants.toggleActive(env, userId, n); view = await adminVariantDetail(env, userId, n); }
      else if (action === 'rn') {
        await requirePerm(env, userId, 'catalog.manage');
        if (!(await Variants.get(env, n))) throw new UserError('بسته‌بندی پیدا نشد.');
        return ask('var_rename', { id: n }, 'نام جدید بسته‌بندی را بفرستید:');
      }
    } else if (ns === 'bp') {
      if (action === 'menu') view = await bulkMenuView(env, userId);
      else if (action === 's' && idOk) {
        await requirePerm(env, userId, 'price.manage');
        return ask('bp_pct', { scope: n }, 'درصد تغییر را بفرستید. مثال: 5 برای افزایش ۵٪ یا -3.5 برای کاهش ۳٫۵٪');
      } else if (action === 'ok') {
        await requirePerm(env, userId, 'price.manage');
        const st = await State.get(env, userId);
        if (!st || st.action !== 'bp_confirm') throw new UserError('زمان تأیید گذشته است. دوباره از «تغییر درصدی قیمت‌ها» شروع کنید.');
        const applied = await BulkPrice.apply(env, userId, st.payload.items, `bp-${Date.now()}`);
        await State.clear(env, userId);
        const total = st.payload.items.length;
        view = {
          text: `✅ قیمت ${fmt(applied)} بسته‌بندی از ${fmt(total)} مورد تغییر کرد.` + (applied < total ? '\nقیمت بعضی موارد بین پیش‌نمایش و تأیید عوض شده بود و دست‌نخورده ماند.' : ''),
          keyboard: [[btn('🔙 پنل مدیریت', 'adm:menu')]],
        };
      } else if (action === 'no') { await State.clear(env, userId); view = await adminMenuView(env, userId); }
    }
    await answer();
    if (view) await showView(env, chat.id, messageId, view);
  } catch (err) {
    if (err instanceof UserError) { await answer(err.message); return; }
    throw err;
  }
}

// ───────────────────────── HTTP entry ─────────────────────────

import { Categories, MAX_IMAGES_PER_PRODUCT, State, UserError, cleanText, currencyLabel, fmt, getAccess, normalizeDigits, parseDecimalIn, parseIntIn } from './core.js';
import { BulkPrice, Variants } from './stock.js';
import { ProductImages, Products } from './store.js';
import { adminCategoryDetail, adminMenuView, adminRoleChoiceView, btn, customerHome } from './views_a.js';
import { stateBroadcast } from './broadcast.js';
import { stateConfig } from './config.js';
import { Cart, Orders, Settings, parseCard } from './orders.js';
import { stateSupport } from './support.js';
import { Payments, notifyReviewers } from './payments.js';
import { cardView, cartView, checkoutConfirmView, customerOrderView, paymentCaption, paymentKeyboard } from './orders_views.js';
import { CANCEL_HINT, adminProductDetail, adminVariantDetail, bulkPreviewView, say, showView, upsertUser } from './views_b.js';
export async function handleState(env, userId, chatId, state, text, msg) {
  const p = state.payload;
  const done = () => State.clear(env, userId);
  switch (state.action) {
    case 'cat_new': {
      const id = await Categories.create(env, userId, { parentId: p.parentId || null, name: text });
      await done(); return showView(env, chatId, null, await adminCategoryDetail(env, userId, id));
    }
    case 'cat_rename': {
      await Categories.rename(env, userId, p.id, text);
      await done(); return showView(env, chatId, null, await adminCategoryDetail(env, userId, p.id));
    }
    case 'adm_add_id': {
      const id = parseIntIn(text, { min: 1, max: 999_999_999_999_999, label: 'شناسه‌ی تلگرام' });
      const view = await adminRoleChoiceView(env, userId, id);
      await done(); return showView(env, chatId, null, view);
    }
    case 'prd_new': {
      const id = await Products.create(env, userId, text);
      await done(); return showView(env, chatId, null, await adminProductDetail(env, userId, id));
    }
    case 'prd_edit': {
      await Products.update(env, userId, p.id, p.field, text);
      await done(); return showView(env, chatId, null, await adminProductDetail(env, userId, p.id));
    }
    case 'prd_photo': {
      const sizes = Array.isArray(msg?.photo) ? msg.photo : [];
      const best = sizes[sizes.length - 1];
      if (!best?.file_id) throw new UserError('لطفاً عکس را به‌صورت «عکس» بفرستید (نه فایل).' );
      const count = await ProductImages.add(env, userId, p.id, best.file_id, best.file_unique_id);
      await State.set(env, userId, 'prd_photo', p); // keep the flow open for more photos
      return showView(env, chatId, null, { text: `✅ عکس اضافه شد (${fmt(count)} از ${fmt(MAX_IMAGES_PER_PRODUCT)}). عکس بعدی را بفرستید یا «پایان» را بزنید.`, keyboard: [[btn('✅ پایان', `prd:im:${p.id}`)]] });
    }
    case 'prd_spec': {
      await Products.addSpec(env, userId, p.id, text);
      await done(); return showView(env, chatId, null, await adminProductDetail(env, userId, p.id));
    }
    case 'var_new': {
      const cur = await currencyLabel(env);
      if (p.step === 'label') {
        const label = cleanText(text, { max: 60, label: 'نام بسته‌بندی' });
        await State.set(env, userId, 'var_new', { ...p, step: 'sku', label });
        return say(env, chatId, 'کد کالا (SKU) را بفرستید: فقط حروف انگلیسی، عدد و - _ . (مثلاً AC-4L)' + CANCEL_HINT);
      }
      if (p.step === 'sku') {
        const sku = Variants.validateSku(text);
        if (await env.DB.prepare('SELECT 1 AS x FROM product_variants WHERE sku = ?1').bind(sku).first()) throw new UserError('این کد کالا قبلاً استفاده شده است.');
        await State.set(env, userId, 'var_new', { ...p, step: 'price', sku });
        return say(env, chatId, `قیمت را به ${cur} بفرستید (فقط عدد):` + CANCEL_HINT);
      }
      if (p.step === 'price') {
        const price = Variants.validatePrice(text);
        await State.set(env, userId, 'var_new', { ...p, step: 'stock', price });
        return say(env, chatId, 'موجودی اولیه را بفرستید (عدد؛ صفر هم مجاز است):' + CANCEL_HINT);
      }
      if (p.step === 'stock') {
        const stock = parseIntIn(text, { min: 0, max: 1_000_000, label: 'موجودی' });
        await State.set(env, userId, 'var_new', { ...p, step: 'weight', stock });
        return say(env, chatId, 'وزن را به کیلوگرم بفرستید (مثلاً 4.5) یا برای رد کردن «-» بفرستید:' + CANCEL_HINT);
      }
      if (p.step === 'weight') {
        const weight = Variants.parseWeight(text);
        const id = await Variants.create(env, userId, { pid: p.pid, label: p.label, sku: p.sku, price: p.price, stock: p.stock, weight });
        await done(); return showView(env, chatId, null, await adminVariantDetail(env, userId, id));
      }
      return done();
    }
    case 'var_price': {
      const r = await Variants.setPrice(env, userId, p.id, text);
      await done();
      const cur = await currencyLabel(env);
      await say(env, chatId, `✅ قیمت از ${fmt(r.old)} به ${fmt(r.price)} ${cur} تغییر کرد.`);
      return showView(env, chatId, null, await adminVariantDetail(env, userId, p.id));
    }
    case 'var_rename': {
      await Variants.rename(env, userId, p.id, text);
      await done(); return showView(env, chatId, null, await adminVariantDetail(env, userId, p.id));
    }
    case 'stock_qty': {
      const qty = parseIntIn(text, { min: p.mode === 'set' ? 0 : 1, max: 1_000_000, label: 'تعداد' });
      await State.set(env, userId, 'stock_reason', { ...p, qty });
      return say(env, chatId, 'دلیل تغییر موجودی را بنویسید (مثلاً «ورود محموله» یا «شمارش انبار»):' + CANCEL_HINT);
    }
    case 'stock_reason': {
      const r = await Variants.adjustStock(env, userId, p.vid, p.mode, p.qty, text);
      await done();
      await say(env, chatId, `✅ موجودی تغییر کرد (${r.delta > 0 ? '+' : ''}${fmt(r.delta)}). موجودی جدید: ${fmt(r.after)}`);
      return showView(env, chatId, null, await adminVariantDetail(env, userId, p.vid));
    }
    case 'bp_pct': {
      const pct = parseDecimalIn(text, { min: -90, max: 300, label: 'درصد' });
      if (pct === 0) throw new UserError('درصد نمی‌تواند صفر باشد.');
      const items = await BulkPrice.preview(env, userId, p.scope, pct);
      await State.set(env, userId, 'bp_confirm', { scope: p.scope, pct, items });
      return showView(env, chatId, null, await bulkPreviewView(env, items, pct));
    }
    case 'ord_name': {
      const name = cleanText(text, { min: 2, max: 60, label: 'نام' });
      await State.set(env, userId, 'ord_phone', { name });
      return say(env, chatId, 'شماره موبایل گیرنده را بفرستید:' + CANCEL_HINT);
    }
    case 'ord_phone': {
      const phone = normalizeDigits(text).replace(/^\+/, '');
      if (!/^\d{10,13}$/.test(phone)) throw new UserError('شماره موبایل معتبر نیست. مثال: 09123456789');
      await State.set(env, userId, 'ord_addr', { ...p, phone });
      return say(env, chatId, 'آدرس کامل تحویل را بفرستید:' + CANCEL_HINT);
    }
    case 'ord_addr': {
      const address = cleanText(text, { min: 10, max: 300, label: 'آدرس' });
      const d = { name: p.name, phone: p.phone, address };
      const view = await checkoutConfirmView(env, userId, d);
      await State.set(env, userId, 'ord_confirm', d);
      return showView(env, chatId, null, view);
    }
    case 'ord_receipt': {
      const sizes = Array.isArray(msg?.photo) ? msg.photo : [];
      const best = sizes[sizes.length - 1];
      if (!best?.file_id) throw new UserError('لطفاً رسید را به‌صورت «عکس» بفرستید (نه فایل و نه متن).');
      const { order, payment } = await Orders.submitReceipt(env, userId, p.orderId, best.file_id, best.file_unique_id);
      await done();
      const items = await Orders.items(env, order.id);
      const cust = await Orders.customer(env, order);
      await notifyReviewers(env, paymentCaption(order, items, cust), best.file_id, paymentKeyboard(payment.id, order.id));
      await say(env, chatId, '✅ رسید شما دریافت شد. پس از بررسی، نتیجه به شما اعلام می‌شود.');
      return showView(env, chatId, null, await customerOrderView(env, userId, order.id));
    }
    case 'pay_reject': {
      const r = await Payments.reject(env, userId, p.paymentId, text);
      await done();
      const cust = await Orders.customer(env, r.order);
      try {
        await say(env, cust.telegram_id, `❌ رسید سفارش ${r.order.public_code} تأیید نشد.\nدلیل: ${r.reason}\nمی‌توانید از «سفارش‌های من» رسید درست را دوباره بفرستید.`);
      } catch { /* customer may have blocked the bot */ }
      return say(env, chatId, `رسید رد شد و به مشتری اطلاع داده شد (${r.order.public_code}).`);
    }
    case 'set_card': {
      const number = parseCard(text);
      await State.set(env, userId, 'set_holder', { number });
      return say(env, chatId, 'نام صاحب کارت را بفرستید (برای نداشتن نام، یک خط تیره - بفرستید):' + CANCEL_HINT);
    }
    case 'set_holder': {
      await Settings.setCard(env, userId, p.number, text);
      await done(); return showView(env, chatId, null, await cardView(env, userId));
    }
    case 'cart_qty': {
      const q = parseIntIn(text, { min: 1, max: 999, label: 'تعداد' });
      await Cart.change(env, userId, p.vid, q);
      await done(); return showView(env, chatId, null, await cartView(env, userId));
    }
    default: {
      if (state.action === 'bc_msg') { if (await stateBroadcast(env, userId, chatId, state, msg)) await done(); return; }
      if (state.action.startsWith('sp_') || state.action.startsWith('cfg_')) {
        const r = state.action.startsWith('sp_') ? await stateSupport(env, userId, chatId, state, text) : await stateConfig(env, userId, chatId, state, text);
        if (r === true) await done();
        return; // 'keep' = flow continues; false = unknown state
      } // e.g. bp_confirm waits for the confirm button, not for text
    }
  }
}

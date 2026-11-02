import { resolveStoreSlug } from './store.js';

// Um carrinho por loja (em localhost todas as lojas dividem a mesma origem).
const STORAGE_KEY = `acai_cart_v1:${resolveStoreSlug()}`;

function readRaw() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return { items: [] };
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed.items)) return { items: [] };
    return parsed;
  } catch {
    return { items: [] };
  }
}

function writeRaw(cart) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(cart));
  } catch {
    // modo privado / armazenamento cheio — o carrinho só não persiste.
  }
  window.dispatchEvent(new CustomEvent('cart:changed'));
}

export function getCart() {
  return readRaw();
}

// Mesmo produto + mesmo tamanho + mesmos adicionais = mesma linha (soma a
// quantidade). Qualquer diferença vira linha separada.
function sameChoice(item, productId, sizeId, addons) {
  if (item.productId !== productId || (item.sizeId || null) !== (sizeId || null)) return false;
  if (item.addons.length !== addons.length) return false;
  const a = item.addons.map((x) => x.addonId).sort();
  const b = addons.map((x) => x.addonId).sort();
  return a.every((id, i) => id === b[i]);
}

// priced = resultado de pricing.priceItem (unitPrice + addons já marcados grátis/pagos)
export function addItem({ product, size, priced, quantity }) {
  const cart = readRaw();
  const sizeId = size ? size.size_id : null;
  const existing = cart.items.find((i) => sameChoice(i, product.id, sizeId, priced.addons));

  if (existing) {
    existing.quantity += quantity;
    existing.lineTotal = existing.unitPrice * existing.quantity;
  } else {
    cart.items.push({
      cartItemId: crypto.randomUUID(),
      productId: product.id,
      productName: product.name,
      sizeId,
      sizeName: size ? size.name : null,
      addons: priced.addons.map((a) => ({ addonId: a.addonId, addonName: a.addonName, groupName: a.groupName, price: a.price, free: a.free })),
      unitPrice: priced.unitPrice,
      quantity,
      lineTotal: priced.unitPrice * quantity,
    });
  }

  writeRaw(cart);
}

export function updateQuantity(cartItemId, quantity) {
  const cart = readRaw();
  const item = cart.items.find((i) => i.cartItemId === cartItemId);
  if (!item) return;
  if (quantity < 1) {
    cart.items = cart.items.filter((i) => i.cartItemId !== cartItemId);
  } else {
    item.quantity = Math.min(quantity, 99);
    item.lineTotal = item.unitPrice * item.quantity;
  }
  writeRaw(cart);
}

export function removeItem(cartItemId) {
  const cart = readRaw();
  cart.items = cart.items.filter((i) => i.cartItemId !== cartItemId);
  writeRaw(cart);
}

export function clearCart() {
  writeRaw({ items: [] });
}

export function computeSubtotal() {
  return readRaw().items.reduce((sum, i) => sum + i.lineTotal, 0);
}

export function itemCount() {
  return readRaw().items.reduce((sum, i) => sum + i.quantity, 0);
}

// Texto curto dos adicionais pra carrinho/resumo: "Açaí, Banana (grátis), Nutella"
export function addonsLabel(addons) {
  return addons.map((a) => (a.free ? `${a.addonName} (grátis)` : a.addonName)).join(', ');
}

// Formato aceito por create_acai_order — o servidor recalcula tudo de novo.
export function toRpcItems() {
  return readRaw().items.map((i) => ({
    product_id: i.productId,
    size_id: i.sizeId,
    quantity: i.quantity,
    addon_ids: i.addons.map((a) => a.addonId),
  }));
}

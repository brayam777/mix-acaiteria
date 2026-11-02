import { isConfigured } from './supabase-config.js';
import { getStoreId } from './store.js';
import { loadSettings, deliveryFeeFor } from './settings.js';
import { loadBusinessHours, isWithinBusinessHours, todayHoursLabel } from './business-hours.js';
import { applyStoreBranding, renderBrandBadge } from './branding.js';
import { loadCatalog } from './catalog.js';
import { priceItem, addonPrice, currency } from './pricing.js';
import * as cart from './cart.js';
import { esc } from './escape.js';

const categoryFilters = document.getElementById('categoryFilters');
const menuSections = document.getElementById('menuSections');
const storeClosedBanner = document.getElementById('storeClosedBanner');
const cartBtn = document.getElementById('cartBtn');
const cartCount = document.getElementById('cartCount');
const cartDrawer = document.getElementById('cartDrawer');
const cartOverlay = document.getElementById('cartOverlay');
const cartCloseBtn = document.getElementById('cartCloseBtn');
const cartItemsEl = document.getElementById('cartItems');
const cartSubtotalEl = document.getElementById('cartSubtotal');
const checkoutBtn = document.getElementById('checkoutBtn');
const productModal = document.getElementById('productModal');
const modalOverlay = document.getElementById('modalOverlay');
const modalCloseBtn = document.getElementById('modalCloseBtn');
const modalBody = document.getElementById('modalBody');

let catalog = null;
let visibleProducts = [];
let activeCategoryId = 'all';

// Tamanhos que o cliente pode escolher agora (os indisponíveis somem). Um
// produto COM tamanhos cadastrados mas todos indisponíveis sai do cardápio.
function availableSizes(product) {
  return (catalog.sizesByProduct.get(product.id) || []).filter((s) => s.is_available);
}

function hasSizes(product) {
  return (catalog.sizesByProduct.get(product.id) || []).length > 0;
}

async function loadMenu() {
  if (!isConfigured) {
    menuSections.innerHTML = '<p class="catalog-empty">O cardápio ainda não foi configurado.</p>';
    return;
  }
  try {
    catalog = await loadCatalog(await getStoreId());
  } catch (err) {
    console.error('catalog error', err);
    menuSections.innerHTML = '<p class="catalog-empty">Não foi possível carregar o cardápio. Atualize a página.</p>';
    return;
  }
  visibleProducts = catalog.products.filter((p) => !hasSizes(p) || availableSizes(p).length > 0);
  renderCategoryFilters();
  renderMenu();
}

function renderCategoryFilters() {
  const used = new Set(visibleProducts.map((p) => p.category_id));
  const cats = catalog.categories.filter((c) => c.is_active && used.has(c.id));
  categoryFilters.innerHTML = ['<button class="filter-btn active" data-cat="all">Todos</button>']
    .concat(cats.map((c) => `<button class="filter-btn" data-cat="${esc(c.id)}">${esc(c.name)}</button>`))
    .join('');
}

function priceChips(p) {
  const sizes = availableSizes(p);
  if (!sizes.length) return `<span class="product-price-chip"><strong>${currency(p.price)}</strong></span>`;
  if (sizes.length > 3) {
    return `<span class="product-price-chip">a partir de <strong>${currency(Math.min(...sizes.map((s) => s.price)))}</strong></span>`;
  }
  return sizes.map((s) => `<span class="product-price-chip">${esc(s.name)} <strong>${currency(s.price)}</strong></span>`).join('');
}

function productCard(p) {
  return `
    <div class="product-card" data-product="${esc(p.id)}">
      ${p.is_new ? '<span class="product-new-badge">NOVO!</span>' : ''}
      <div class="product-media">
        ${p.image_url ? `<img src="${esc(p.image_url)}" alt="${esc(p.name)}" loading="lazy" />` : '<span class="product-media-placeholder">🍇</span>'}
      </div>
      <div class="product-body">
        <h3 class="product-name">${esc(p.name)}</h3>
        ${p.description ? `<p class="product-desc">${esc(p.description)}</p>` : ''}
        <div class="product-prices">${priceChips(p)}</div>
        <div class="product-footer">
          <button class="btn btn-primary btn-sm" data-add="${esc(p.id)}">Escolher</button>
        </div>
      </div>
    </div>`;
}

function renderMenu() {
  const activeCats = catalog.categories.filter((c) => c.is_active);
  const activeCatIds = new Set(activeCats.map((c) => c.id));
  // Produto de categoria desativada não aparece; sem categoria vai pra "Outros".
  const list = visibleProducts.filter((p) => !p.category_id || activeCatIds.has(p.category_id));
  const shown = activeCategoryId === 'all' ? list : list.filter((p) => p.category_id === activeCategoryId);

  if (shown.length === 0) {
    menuSections.innerHTML = '<p class="catalog-empty">Nenhum item disponível no momento.</p>';
    return;
  }

  if (activeCategoryId !== 'all') {
    menuSections.innerHTML = `<div class="product-grid">${shown.map(productCard).join('')}</div>`;
    return;
  }

  const sections = activeCats
    .map((c) => ({ name: c.name, items: shown.filter((p) => p.category_id === c.id) }))
    .concat([{ name: 'Outros', items: shown.filter((p) => !p.category_id) }])
    .filter((g) => g.items.length > 0);

  menuSections.innerHTML = sections
    .map(
      (g) => `
      <div class="category-group">
        <h2 class="category-heading">${esc(g.name)}</h2>
        <div class="product-grid">${g.items.map(productCard).join('')}</div>
      </div>`
    )
    .join('');
}

// ---------------- Modal do produto ----------------
function groupHintHtml(link, state) {
  const tags = [];
  if (state.min > 0 && state.max === state.min) tags.push(`<span class="hint-tag">Escolha ${state.min}</span>`);
  else if (state.min > 0) tags.push(`<span class="hint-tag">Mínimo ${state.min}</span>`);
  if (state.max !== null && state.max !== state.min) tags.push(`<span class="hint-tag">Até ${state.max}</span>`);
  if (state.free > 0) {
    const left = state.freeLeft;
    tags.push(`<span class="hint-tag free">${state.free} grátis${left < state.free ? ` · ${left} restante${left === 1 ? '' : 's'}` : ''}</span>`);
  }
  if (state.min > 0) tags.push('<span class="required-tag">obrigatório</span>');
  return tags.length ? `<p class="option-group-hint">${tags.join('')}</p>` : '';
}

function openProductModal(productId) {
  const product = visibleProducts.find((p) => p.id === productId);
  if (!product) return;

  const sizes = availableSizes(product);
  const links = (catalog.linksByProduct.get(product.id) || []).filter((l) => (catalog.addonsByGroup.get(l.group_id) || []).length > 0);
  let size = sizes[0] || null;
  let quantity = 1;
  const selected = new Set();

  modalBody.innerHTML = `
    <div class="modal-product">
      ${product.image_url ? `<img class="modal-product-img" src="${esc(product.image_url)}" alt="${esc(product.name)}" />` : ''}
      <h2>${esc(product.name)}</h2>
      ${product.description ? `<p class="modal-product-desc">${esc(product.description)}</p>` : ''}
      ${
        sizes.length
          ? `<div class="size-picker">
              <p class="size-picker-title">Tamanho</p>
              <div class="size-options">
                ${sizes
                  .map(
                    (s, i) => `
                  <label class="size-option">
                    <input type="radio" name="size" value="${esc(s.size_id)}" ${i === 0 ? 'checked' : ''} />
                    <strong>${esc(s.name)}</strong>
                    <span>${currency(s.price)}</span>
                  </label>`
                  )
                  .join('')}
              </div>
            </div>`
          : ''
      }
      <div id="modalOptionGroups"></div>
      <div class="modal-quantity-row">
        <span>Quantidade</span>
        <div class="qty-stepper">
          <button type="button" id="qtyMinus" class="qty-btn" aria-label="Diminuir">−</button>
          <span id="qtyValue">1</span>
          <button type="button" id="qtyPlus" class="qty-btn" aria-label="Aumentar">+</button>
        </div>
      </div>
      <div class="modal-footer">
        <p id="modalError" class="modal-error" hidden></p>
        <button id="addToCartBtn" class="btn btn-primary btn-block">
          Adicionar — <span id="modalTotal"></span>
        </button>
      </div>
    </div>`;

  const groupsEl = document.getElementById('modalOptionGroups');
  const qtyValueEl = document.getElementById('qtyValue');
  const modalTotalEl = document.getElementById('modalTotal');
  const modalErrorEl = document.getElementById('modalError');

  const basePrice = () => (size ? size.price : Number(product.price));
  const compute = () =>
    priceItem({ basePrice: basePrice(), sizeId: size?.size_id || null, links, addonsByGroup: catalog.addonsByGroup, selectedIds: selected });

  // Redesenha os grupos inteiros a cada mudança: a cota grátis, o preço por
  // tamanho e o limite de cada grupo mudam junto com o que foi escolhido.
  function render() {
    const priced = compute();
    const freeById = new Map(priced.addons.map((a) => [a.addonId, a.free]));

    groupsEl.innerHTML = links
      .map((link) => {
        const state = priced.groups.get(link.group_id);
        const single = state.min === 1 && state.max === 1;
        const full = state.max !== null && state.count >= state.max;
        const options = catalog.addonsByGroup.get(link.group_id) || [];
        return `
          <fieldset class="option-group" data-group="${esc(link.group_id)}">
            <legend>${esc(link.group_name)}</legend>
            ${groupHintHtml(link, state)}
            ${options
              .map((o) => {
                const price = addonPrice(o, size?.size_id);
                const checked = selected.has(o.id);
                const disabled = !single && !checked && full;
                let tag = '';
                if (price > 0) {
                  const willBeFree = checked ? freeById.get(o.id) : state.freeLeft > 0;
                  tag = willBeFree ? '<span class="option-delta free">grátis</span>' : `<span class="option-delta">+ ${currency(price)}</span>`;
                }
                return `
                  <label class="option-row${disabled ? ' is-disabled' : ''}">
                    <input type="${single ? 'radio' : 'checkbox'}" name="group-${esc(link.group_id)}" value="${esc(o.id)}" ${checked ? 'checked' : ''} ${disabled ? 'disabled' : ''} />
                    <span class="option-name">${esc(o.name)}</span>
                    ${tag}
                  </label>`;
              })
              .join('')}
          </fieldset>`;
      })
      .join('');

    modalTotalEl.textContent = currency(priced.unitPrice * quantity);
  }

  groupsEl.addEventListener('change', (e) => {
    const input = e.target;
    const groupId = input.closest('[data-group]')?.dataset.group;
    if (!groupId) return;
    if (input.type === 'radio') {
      for (const o of catalog.addonsByGroup.get(groupId) || []) selected.delete(o.id);
      selected.add(input.value);
    } else if (input.checked) {
      selected.add(input.value);
    } else {
      selected.delete(input.value);
    }
    modalErrorEl.hidden = true;
    render();
  });

  modalBody.querySelectorAll('input[name="size"]').forEach((input) =>
    input.addEventListener('change', () => {
      size = sizes.find((s) => s.size_id === input.value) || size;
      render();
    })
  );

  document.getElementById('qtyMinus').addEventListener('click', () => {
    quantity = Math.max(1, quantity - 1);
    qtyValueEl.textContent = quantity;
    render();
  });
  document.getElementById('qtyPlus').addEventListener('click', () => {
    quantity = Math.min(99, quantity + 1);
    qtyValueEl.textContent = quantity;
    render();
  });

  document.getElementById('addToCartBtn').addEventListener('click', () => {
    const priced = compute();
    if (priced.error) {
      modalErrorEl.textContent = priced.error;
      modalErrorEl.hidden = false;
      return;
    }
    cart.addItem({ product, size, priced, quantity });
    closeProductModal();
    openCartDrawer();
  });

  render();
  productModal.hidden = false;
  modalBody.parentElement.scrollTop = 0;
  document.body.style.overflow = 'hidden';
}

function closeProductModal() {
  productModal.hidden = true;
  document.body.style.overflow = '';
}

// ---------------- Carrinho ----------------
function renderCart() {
  const { items } = cart.getCart();
  if (items.length === 0) {
    cartItemsEl.innerHTML = '<p class="cart-empty">Seu carrinho está vazio.</p>';
    checkoutBtn.disabled = true;
  } else {
    cartItemsEl.innerHTML = items
      .map(
        (i) => `
        <div class="cart-item" data-cart-item="${esc(i.cartItemId)}">
          <div class="cart-item-info">
            <span class="cart-item-name">${esc(i.productName)}${i.sizeName ? ` · ${esc(i.sizeName)}` : ''}</span>
            ${i.addons.length ? `<span class="cart-item-options">${esc(cart.addonsLabel(i.addons))}</span>` : ''}
            <span class="cart-item-price">${currency(i.unitPrice)} un.</span>
          </div>
          <div class="cart-item-actions">
            <div class="qty-stepper qty-stepper-sm">
              <button type="button" class="qty-btn" data-qty-minus="${esc(i.cartItemId)}" aria-label="Diminuir">−</button>
              <span>${esc(i.quantity)}</span>
              <button type="button" class="qty-btn" data-qty-plus="${esc(i.cartItemId)}" aria-label="Aumentar">+</button>
            </div>
            <button type="button" class="cart-item-remove" data-remove="${esc(i.cartItemId)}">Remover</button>
          </div>
        </div>`
      )
      .join('');
    checkoutBtn.disabled = false;
  }

  cartSubtotalEl.textContent = currency(cart.computeSubtotal());
  const count = cart.itemCount();
  cartCount.textContent = count;
  cartCount.hidden = count === 0;
}

function openCartDrawer() {
  cartDrawer.hidden = false;
  document.body.style.overflow = 'hidden';
}

function closeCartDrawer() {
  cartDrawer.hidden = true;
  document.body.style.overflow = '';
}

categoryFilters.addEventListener('click', (e) => {
  const btn = e.target.closest('.filter-btn');
  if (!btn) return;
  activeCategoryId = btn.dataset.cat;
  categoryFilters.querySelectorAll('.filter-btn').forEach((b) => b.classList.toggle('active', b === btn));
  renderMenu();
});

menuSections.addEventListener('click', (e) => {
  const card = e.target.closest('[data-add], .product-card');
  if (!card) return;
  openProductModal(card.dataset.add || card.dataset.product);
});

cartBtn.addEventListener('click', openCartDrawer);
cartCloseBtn.addEventListener('click', closeCartDrawer);
cartOverlay.addEventListener('click', closeCartDrawer);
modalCloseBtn.addEventListener('click', closeProductModal);
modalOverlay.addEventListener('click', closeProductModal);

cartItemsEl.addEventListener('click', (e) => {
  const minus = e.target.closest('[data-qty-minus]');
  const plus = e.target.closest('[data-qty-plus]');
  const remove = e.target.closest('[data-remove]');
  const { items } = cart.getCart();

  if (minus) {
    const item = items.find((i) => i.cartItemId === minus.dataset.qtyMinus);
    if (item) cart.updateQuantity(item.cartItemId, item.quantity - 1);
  } else if (plus) {
    const item = items.find((i) => i.cartItemId === plus.dataset.qtyPlus);
    if (item) cart.updateQuantity(item.cartItemId, item.quantity + 1);
  } else if (remove) {
    cart.removeItem(remove.dataset.remove);
  }
});

checkoutBtn.addEventListener('click', () => {
  window.location.href = 'checkout.html';
});

window.addEventListener('cart:changed', renderCart);

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    closeProductModal();
    closeCartDrawer();
  }
});

function updateStoreClosedBanner(settings, hours) {
  if (settings.store_open === false) {
    storeClosedBanner.textContent = 'A loja está fechada no momento. Volte mais tarde!';
    storeClosedBanner.hidden = false;
    return;
  }
  if (hours.length && !isWithinBusinessHours(hours)) {
    storeClosedBanner.textContent = `A loja está fechada no momento. ${todayHoursLabel(hours)}.`;
    storeClosedBanner.hidden = false;
    return;
  }
  storeClosedBanner.hidden = true;
}

function renderDeliveryPill(settings) {
  const pill = document.getElementById('deliveryPill');
  const fee = deliveryFeeFor(settings);
  const text = settings.delivery_note || (fee > 0 ? `Entrega: ${currency(fee)}` : 'Entrega grátis');
  pill.textContent = `🛵 ${text}`;
  pill.hidden = false;
}

async function init() {
  const [settings, hours] = await Promise.all([loadSettings(), loadBusinessHours()]);
  applyStoreBranding(settings, 'Cardápio');
  renderBrandBadge();
  updateStoreClosedBanner(settings, hours);
  renderDeliveryPill(settings);
  renderCart();
  await loadMenu();
}

init();

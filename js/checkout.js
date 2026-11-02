import { supabase, isConfigured } from './supabase-config.js';
import { getStoreId } from './store.js';
import { loadSettings, deliveryFeeFor } from './settings.js';
import { loadBusinessHours, isWithinBusinessHours, todayHoursLabel } from './business-hours.js';
import { applyStoreBranding, renderBrandBadge } from './branding.js';
import { normalizeBrazilPhone, PHONE_FORMAT_HINT } from './phone.js';
import { currency } from './pricing.js';
import { buildOrderMessage, paymentText, saveOrderMessage } from './whatsapp.js';
import * as cart from './cart.js';
import { esc } from './escape.js';

const checkoutForm = document.getElementById('checkoutForm');
const emptyCartNotice = document.getElementById('emptyCartNotice');
const summaryItems = document.getElementById('summaryItems');
const summarySubtotal = document.getElementById('summarySubtotal');
const summaryDeliveryRow = document.getElementById('summaryDeliveryRow');
const summaryDeliveryFee = document.getElementById('summaryDeliveryFee');
const summaryTotal = document.getElementById('summaryTotal');
const addressFields = document.getElementById('addressFields');
const deliveryInfo = document.getElementById('deliveryInfo');
const pickupInfo = document.getElementById('pickupInfo');
const pickupOption = document.getElementById('pickupOption');
const cashFields = document.getElementById('cashFields');
const needsChange = document.getElementById('needsChange');
const changeForField = document.getElementById('changeForField');
const checkoutError = document.getElementById('checkoutError');
const submitOrderBtn = document.getElementById('submitOrderBtn');
const addressNumberInput = document.getElementById('addressNumber');
const addressNoNumberCheckbox = document.getElementById('addressNoNumber');

const SAVED_CUSTOMER_KEY = 'acai_checkout_customer_v1';

let settings = {};
let businessHours = [];
let deliveryFee = 0;

function isDelivery() {
  return checkoutForm.fulfillmentType.value === 'delivery';
}

function renderSummary() {
  const { items } = cart.getCart();
  if (items.length === 0) {
    checkoutForm.hidden = true;
    emptyCartNotice.hidden = false;
    return;
  }

  summaryItems.innerHTML = items
    .map(
      (i) => `
      <div class="summary-item">
        <span>${esc(i.quantity)}x ${esc(i.productName)}${i.sizeName ? ` (${esc(i.sizeName)})` : ''}
          ${i.addons.length ? `<small>${esc(cart.addonsLabel(i.addons))}</small>` : ''}</span>
        <span>${currency(i.lineTotal)}</span>
      </div>`
    )
    .join('');

  const subtotal = cart.computeSubtotal();
  const fee = isDelivery() ? deliveryFee : 0;

  summarySubtotal.textContent = currency(subtotal);
  summaryDeliveryRow.hidden = !isDelivery();
  summaryDeliveryFee.innerHTML = fee > 0 ? currency(fee) : '<span class="free-text">Grátis</span>';
  summaryTotal.textContent = currency(subtotal + fee);
}

function updateFulfillmentUI() {
  const delivery = isDelivery();
  addressFields.hidden = !delivery;
  pickupInfo.innerHTML =
    !delivery && settings.pickup_address ? `<p class="checkout-hint">Endereço da loja: ${esc(settings.pickup_address)}</p>` : '';
  renderSummary();
}

function updatePaymentUI() {
  const isCash = checkoutForm.paymentMethod.value === 'dinheiro';
  cashFields.hidden = !isCash;
  if (!isCash) {
    needsChange.checked = false;
    changeForField.hidden = true;
  }
}

function showError(message) {
  checkoutError.textContent = message;
  checkoutError.hidden = false;
}

function clearError() {
  checkoutError.hidden = true;
}

const ERROR_MESSAGES = {
  missing_customer_name: 'Informe seu nome.',
  missing_customer_phone: 'Informe seu telefone.',
  invalid_phone_format: `Telefone inválido. ${PHONE_FORMAT_HINT}`,
  invalid_fulfillment_type: 'Escolha entrega ou retirada.',
  pickup_disabled: 'No momento a loja só faz entrega.',
  address_required: 'Informe o endereço de entrega.',
  invalid_payment_method: 'Escolha uma forma de pagamento.',
  empty_order: 'Seu carrinho está vazio.',
  store_closed: 'A loja está fechada no momento. Tente novamente mais tarde.',
  product_unavailable: 'Um dos itens do carrinho não está mais disponível. Revise seu pedido.',
  invalid_size: 'Um dos tamanhos escolhidos não está mais disponível. Revise seu pedido.',
  invalid_option: 'Um dos adicionais escolhidos não está mais disponível. Revise seu pedido.',
  option_below_minimum: 'Falta escolher alguma opção obrigatória em um dos itens. Revise seu pedido.',
  option_above_maximum: 'Um dos itens passou do limite de adicionais. Revise seu pedido.',
  invalid_quantity: 'Quantidade inválida em um dos itens.',
  too_many_items: 'Pedido grande demais — fale com a loja pelo WhatsApp.',
};

function friendlyError(rawMessage) {
  if (rawMessage.includes('outside_business_hours')) {
    return `A loja está fechada nesse horário. ${todayHoursLabel(businessHours)}.`;
  }
  const key = Object.keys(ERROR_MESSAGES).find((k) => rawMessage.includes(k));
  return key ? ERROR_MESSAGES[key] : 'Não foi possível enviar seu pedido. Tente novamente.';
}

function readAddress() {
  return {
    street: document.getElementById('addressStreet').value.trim(),
    number: addressNumberInput.value.trim(),
    neighborhood: document.getElementById('addressNeighborhood').value.trim(),
    city: document.getElementById('addressCity').value.trim(),
    complement: document.getElementById('addressComplement').value.trim(),
    reference: document.getElementById('addressReference').value.trim(),
  };
}

// Lembra nome/telefone/endereço neste aparelho pra próxima compra.
function saveCustomer(address) {
  try {
    localStorage.setItem(
      SAVED_CUSTOMER_KEY,
      JSON.stringify({
        name: document.getElementById('customerName').value.trim(),
        phone: document.getElementById('customerPhone').value.trim(),
        address,
      })
    );
  } catch {
    // sem armazenamento — só não lembra.
  }
}

function restoreCustomer() {
  let saved = null;
  try {
    saved = JSON.parse(localStorage.getItem(SAVED_CUSTOMER_KEY) || 'null');
  } catch {
    saved = null;
  }
  if (!saved) return;
  document.getElementById('customerName').value = saved.name || '';
  document.getElementById('customerPhone').value = saved.phone || '';
  const a = saved.address;
  if (!a) return;
  document.getElementById('addressStreet').value = a.street || '';
  document.getElementById('addressNeighborhood').value = a.neighborhood || '';
  document.getElementById('addressCity').value = a.city || document.getElementById('addressCity').value;
  document.getElementById('addressComplement').value = a.complement || '';
  document.getElementById('addressReference').value = a.reference || '';
  if (a.number === 'S/N') {
    addressNoNumberCheckbox.checked = true;
    addressNumberInput.value = 'S/N';
    addressNumberInput.disabled = true;
  } else {
    addressNumberInput.value = a.number || '';
  }
}

async function handleSubmit(e) {
  e.preventDefault();
  clearError();

  if (!isConfigured) {
    showError('O sistema de pedidos ainda não foi configurado.');
    return;
  }

  const name = document.getElementById('customerName').value.trim();
  if (!name) {
    showError('Informe seu nome.');
    return;
  }

  const customerPhone = normalizeBrazilPhone(document.getElementById('customerPhone').value);
  if (!customerPhone) {
    showError(`Telefone inválido. ${PHONE_FORMAT_HINT}`);
    return;
  }

  const delivery = isDelivery();
  const address = delivery ? readAddress() : null;
  if (delivery && (!address.street || !address.number || !address.neighborhood)) {
    showError('Preencha rua, número (ou "Sem número") e bairro pra entrega.');
    return;
  }

  const isCash = checkoutForm.paymentMethod.value === 'dinheiro';
  const changeFor = parseFloat(document.getElementById('changeFor').value);
  const total = cart.computeSubtotal() + (delivery ? deliveryFee : 0);
  if (isCash && needsChange.checked) {
    if (!changeFor) {
      showError('Informe pra quanto precisa de troco.');
      return;
    }
    if (changeFor < total) {
      showError(`O troco precisa ser pra um valor maior que o total (${currency(total)}).`);
      return;
    }
  }

  submitOrderBtn.disabled = true;
  submitOrderBtn.textContent = 'Enviando...';

  const { data, error } = await supabase.rpc('create_acai_order', {
    p_store_id: await getStoreId(),
    p_customer_name: name,
    p_customer_phone: customerPhone,
    p_fulfillment_type: checkoutForm.fulfillmentType.value,
    p_address: address,
    p_payment_method: checkoutForm.paymentMethod.value,
    p_needs_change: isCash ? needsChange.checked : false,
    p_change_for: isCash && needsChange.checked ? changeFor : null,
    p_notes: document.getElementById('orderNotes').value.trim() || null,
    p_items: cart.toRpcItems(),
  });

  if (error) {
    console.error('create order error', error);
    showError(friendlyError(error.message || ''));
    submitOrderBtn.disabled = false;
    submitOrderBtn.textContent = 'Enviar pedido pelo WhatsApp';
    return;
  }

  saveCustomer(address);
  const result = Array.isArray(data) ? data[0] : data;

  // Número do dia (#1, #2...) pra mensagem; se não vier, a mensagem sai sem número.
  const { data: statusRows } = await supabase.rpc('get_acai_order_status', { p_order_id: result.order_id });
  const orderNumber = statusRows?.[0]?.order_number || null;

  const trackUrl = new URL(`confirmation.html?order=${result.order_id}`, window.location.href).href;
  const message = buildOrderMessage({
    storeName: settings.store_name || 'Açaiteria',
    orderNumber,
    customerName: name,
    customerPhone: document.getElementById('customerPhone').value.trim(),
    fulfillment: checkoutForm.fulfillmentType.value,
    address,
    items: cart.getCart().items.map((i) => ({
      quantity: i.quantity,
      name: i.productName,
      size: i.sizeName,
      lineTotal: i.lineTotal,
      addons: i.addons.map((a) => ({ name: a.addonName, free: a.free })),
    })),
    subtotal: result.items_subtotal,
    deliveryFee: result.delivery_fee,
    total: result.total,
    payment: paymentText(checkoutForm.paymentMethod.value, isCash && needsChange.checked, changeFor),
    notes: document.getElementById('orderNotes').value.trim(),
    trackUrl,
  });
  saveOrderMessage(result.order_id, settings.whatsapp_number, message);

  cart.clearCart();
  // A página do pedido abre o WhatsApp (e fica com o botão "enviar de novo"
  // se o cliente voltar sem ter mandado).
  window.location.href = `confirmation.html?order=${result.order_id}&enviar=1`;
}

checkoutForm.addEventListener('change', (e) => {
  if (e.target.name === 'fulfillmentType') updateFulfillmentUI();
  if (e.target.name === 'paymentMethod') updatePaymentUI();
  if (e.target === needsChange) changeForField.hidden = !needsChange.checked;
});

// "Sem número" — comum em vilas/zona rural. Trava o campo em "S/N" pra ficar
// claro no pedido que não foi esquecido.
addressNoNumberCheckbox.addEventListener('change', () => {
  if (addressNoNumberCheckbox.checked) {
    addressNumberInput.value = 'S/N';
    addressNumberInput.disabled = true;
  } else {
    addressNumberInput.value = '';
    addressNumberInput.disabled = false;
    addressNumberInput.focus();
  }
});

checkoutForm.addEventListener('submit', handleSubmit);

async function init() {
  const [loaded, hours] = await Promise.all([loadSettings(), loadBusinessHours()]);
  settings = loaded;
  businessHours = hours;
  applyStoreBranding(settings, 'Finalizar pedido');
  renderBrandBadge();

  deliveryFee = deliveryFeeFor(settings);
  deliveryInfo.textContent = settings.delivery_note || (deliveryFee > 0 ? `Taxa de entrega: ${currency(deliveryFee)}` : 'Entrega grátis!');
  if (settings.delivery_city) document.getElementById('addressCity').value = settings.delivery_city;

  if (settings.pickup_enabled === false) {
    pickupOption.hidden = true;
    checkoutForm.fulfillmentType.value = 'delivery';
  }

  restoreCustomer();
  updateFulfillmentUI();
  updatePaymentUI();

  if (settings.store_open === false) {
    showError('A loja está fechada no momento. Você pode montar o pedido, mas não vai conseguir enviá-lo agora.');
  } else if (hours.length && !isWithinBusinessHours(hours)) {
    showError(`A loja está fechada nesse horário. Você pode montar o pedido, mas não vai conseguir enviá-lo agora. ${todayHoursLabel(hours)}.`);
  }
}

init();

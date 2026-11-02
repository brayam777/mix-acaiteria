import { supabase, isConfigured } from './supabase-config.js';
import { getStoreId } from './store.js';
import { loadSettings } from './settings.js';
import { applyStoreBranding, renderBrandBadge } from './branding.js';
import { normalizeBrazilPhone, PHONE_FORMAT_HINT } from './phone.js';
import { esc } from './escape.js';
import { waLink, loadOrderMessage } from './whatsapp.js';

import { currency } from './pricing.js';
const card = document.getElementById('confirmationCard');

const PAYMENT_LABELS = {
  cartao_maquininha: '💳 Cartão na maquininha',
  pix_maquininha: '📱 PIX na maquininha',
  dinheiro: '💵 Dinheiro',
};

const STEP_LABELS = {
  received: 'Aguardando a loja confirmar',
  preparing: 'Preparando',
  ready: 'Pronto',
  out_for_delivery: 'Saiu para entrega',
  completed: 'Concluído',
};

function stepsFor(fulfillmentType) {
  return fulfillmentType === 'delivery'
    ? ['received', 'preparing', 'out_for_delivery', 'completed']
    : ['received', 'preparing', 'ready', 'completed'];
}

function paymentDetail(order) {
  let label = PAYMENT_LABELS[order.payment_method] || order.payment_method;
  if (order.payment_method === 'dinheiro') {
    label += order.needs_change ? ` — troco para ${currency(order.change_for)}` : ' — sem troco';
  }
  return label;
}

function renderProgress(order) {
  if (order.status === 'cancelled') {
    return `<div class="order-cancelled-badge">Pedido cancelado</div>`;
  }
  const steps = stepsFor(order.fulfillment_type);
  const currentIndex = steps.indexOf(order.status);
  return `
    <ol class="order-progress">
      ${steps
        .map((step, i) => {
          const state = i < currentIndex ? 'done' : i === currentIndex ? 'current' : 'upcoming';
          return `<li class="order-progress-step ${state}"><span class="order-progress-dot"></span>${esc(STEP_LABELS[step])}</li>`;
        })
        .join('')}
    </ol>`;
}

function renderItems(order) {
  const items = order.items || [];
  if (!items.length) return '';
  return `
    <ul class="confirmation-items">
      ${items
        .map((i) => {
          const addons = (i.selected_addons || []).map((a) => (a.free ? `${a.addon_name} (grátis)` : a.addon_name)).join(', ');
          return `<li>
            <span>${esc(i.quantity)}x ${esc(i.product_name)}${i.size_name ? ` (${esc(i.size_name)})` : ''}${addons ? `<small>${esc(addons)}</small>` : ''}</span>
            <span>${currency(i.line_total)}</span>
          </li>`;
        })
        .join('')}
    </ul>`;
}

function renderWhatsappStep(orderId) {
  const saved = loadOrderMessage(orderId);
  if (!saved?.number || !saved?.text) return '';
  return `
    <div class="wa-step">
      <p><strong>Não recebeu o WhatsApp aberto, ou não enviou?</strong><br>Toque abaixo e envie a mensagem pra loja.</p>
      <a class="btn btn-whatsapp btn-block" href="${esc(waLink(saved.number, saved.text))}">Enviar pedido pelo WhatsApp</a>
    </div>`;
}

function render(order, orderId) {
  card.innerHTML = `
    <div class="confirmation-check">✓</div>
    <h1>Pedido${order.order_number ? ` #${esc(order.order_number)}` : ''} registrado!</h1>
    <p class="checkout-hint">Essa página atualiza sozinha — pode deixar aberta ou voltar aqui depois.</p>
    ${renderWhatsappStep(orderId)}
    ${renderProgress(order)}
    ${renderItems(order)}
    <div class="confirmation-details">
      <div class="summary-row"><span>Total</span><span>${currency(order.total)}</span></div>
      <div class="summary-row"><span>Pagamento</span><span>${esc(paymentDetail(order))}</span></div>
      <div class="summary-row"><span>Entrega</span><span>${order.fulfillment_type === 'delivery' ? 'Receber em casa' : 'Retirar na loja'}</span></div>
    </div>
    <p class="checkout-hint">Pedido: ${esc(orderId)}</p>
    <a href="index.html" class="btn btn-primary btn-block">Fazer novo pedido</a>`;
}

function statusLabel(status) {
  return status === 'cancelled' ? 'Cancelado' : STEP_LABELS[status] || status;
}

// Busca por nome+telefone — pra quem perdeu o link direto do pedido. Só
// existe pra isso: o link direto (com o id do pedido) continua sendo o
// jeito principal de acompanhar, essa busca é o "esqueci o link".
function renderLookupForm(introHtml = '') {
  card.innerHTML = `
    ${introHtml}
    <h1>Status do pedido</h1>
    <p class="checkout-hint">Informe o nome e o telefone usados no pedido pra ver o status.</p>
    <form id="lookupForm">
      <label class="field">
        <span>Nome</span>
        <input type="text" id="lookupName" required />
      </label>
      <label class="field">
        <span>Telefone / WhatsApp</span>
        <input type="tel" id="lookupPhone" placeholder="(00) 00000-0000" required />
      </label>
      <button type="submit" class="btn btn-primary btn-block">Buscar meu pedido</button>
    </form>
    <p id="lookupMessage" class="modal-error" hidden></p>
    <div id="lookupResults"></div>`;

  const form = document.getElementById('lookupForm');
  const message = document.getElementById('lookupMessage');
  const results = document.getElementById('lookupResults');
  const submitBtn = form.querySelector('button[type="submit"]');

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    message.hidden = true;
    results.innerHTML = '';

    const name = document.getElementById('lookupName').value.trim();
    const phone = normalizeBrazilPhone(document.getElementById('lookupPhone').value);
    if (!phone) {
      message.textContent = `Telefone inválido. ${PHONE_FORMAT_HINT}`;
      message.hidden = false;
      return;
    }

    submitBtn.disabled = true;
    submitBtn.textContent = 'Buscando...';

    const { data, error } = await supabase.rpc('get_acai_orders_by_customer', {
      p_store_id: await getStoreId(),
      p_customer_name: name,
      p_customer_phone: phone,
    });

    submitBtn.disabled = false;
    submitBtn.textContent = 'Buscar meu pedido';

    if (error || !data || data.length === 0) {
      message.textContent = 'Não encontramos pedido com esse nome e telefone nos últimos 90 dias. Confira se digitou igual ao que usou no pedido.';
      message.hidden = false;
      return;
    }

    if (data.length === 1) {
      window.location.href = `confirmation.html?order=${data[0].order_id}`;
      return;
    }

    results.innerHTML = `
      <p class="checkout-hint">Encontramos ${data.length} pedidos — escolha qual:</p>
      ${data
        .map(
          (o) => `
        <a class="order-lookup-item" href="confirmation.html?order=${encodeURIComponent(o.order_id)}">
          <span>${new Date(o.created_at).toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' })}</span>
          <span>${esc(statusLabel(o.status))}</span>
          <span>${currency(o.total)}</span>
        </a>`
        )
        .join('')}`;
  });
}

function renderNotFound() {
  renderLookupForm('<p class="modal-error">Não encontramos esse pedido pelo link. Tente buscar pelo nome e telefone abaixo:</p>');
}

async function fetchStatus(orderId) {
  const { data, error } = await supabase.rpc('get_acai_order_status', { p_order_id: orderId });
  if (error || !data || data.length === 0) return null;
  return Array.isArray(data) ? data[0] : data;
}

async function init() {
  const settings = await loadSettings();
  applyStoreBranding(settings, 'Acompanhar pedido');
  renderBrandBadge();

  if (!isConfigured) {
    renderNotFound();
    return;
  }

  const params = new URLSearchParams(window.location.search);
  const orderId = params.get('order');

  if (!orderId) {
    renderLookupForm();
    return;
  }

  const order = await fetchStatus(orderId);
  if (!order) {
    renderNotFound();
    return;
  }
  render(order, orderId);

  // Vindo do checkout: abre o WhatsApp com o pedido UMA vez (voltar pra esta
  // página não reabre — fica o botão).
  if (params.get('enviar') === '1') {
    history.replaceState(null, '', `confirmation.html?order=${encodeURIComponent(orderId)}`);
    const saved = loadOrderMessage(orderId);
    if (saved?.number && saved?.text) window.location.href = waLink(saved.number, saved.text);
  }

  const poll = setInterval(async () => {
    const updated = await fetchStatus(orderId);
    if (!updated) return;
    render(updated, orderId);
    if (updated.status === 'completed' || updated.status === 'cancelled') {
      clearInterval(poll);
    }
  }, 12000);
}

init();

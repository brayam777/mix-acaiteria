import { supabase, isConfigured } from './supabase-config.js';
import { getStoreId } from './store.js';
import { currency } from './pricing.js';
import { esc } from './escape.js';
import { formatBrazilPhone } from './phone.js';
import { waLink, statusMessage } from './whatsapp.js';

const ordersBoard = document.getElementById('ordersBoard');
const ordersCounters = document.getElementById('ordersCounters');
const enableAlertsBtn = document.getElementById('enableAlertsBtn');

const STATUS_LABELS = {
  received: 'Novo pedido — confira o WhatsApp',
  preparing: 'Preparando',
  ready: 'Pronto',
  out_for_delivery: 'Saiu para entrega',
  completed: 'Concluído',
  cancelled: 'Cancelado',
};

const PAYMENT_LABELS = {
  cartao_maquininha: '💳 Cartão na maquininha',
  pix_maquininha: '📱 PIX',
  dinheiro: '💵 Dinheiro',
};

function nextStatus(order) {
  if (order.status === 'received') return 'preparing';
  if (order.status === 'preparing') return order.fulfillment_type === 'delivery' ? 'out_for_delivery' : 'ready';
  if (order.status === 'ready' || order.status === 'out_for_delivery') return 'completed';
  return null;
}

const NEXT_ACTION_LABEL = {
  preparing: 'Aceitar',
  ready: 'Pronto pra retirar',
  out_for_delivery: 'Saiu para entrega',
  completed: 'Concluir',
};

// O quadro mostra os pedidos de hoje e de ontem (os antigos o cron já fechou;
// o histórico completo está no Caixa).
const BOARD_WINDOW_HOURS = 36;

let orders = [];
let orderItemsByOrder = new Map();
let channel = null;
let ordersLoadToken = 0;
const freshIds = new Set();

// ---------------- Alerta de pedido novo (som + notificação) ----------------
// Navegador só toca som depois de um clique na página — por isso o botão.
let audioCtx = null;
const ALERTS_KEY = 'acai_admin_alerts_on';

function beep() {
  if (!audioCtx) return;
  const now = audioCtx.currentTime;
  [0, 0.25, 0.5].forEach((offset, i) => {
    const osc = audioCtx.createOscillator();
    const gain = audioCtx.createGain();
    osc.type = 'sine';
    osc.frequency.value = i === 2 ? 1175 : 880;
    gain.gain.setValueAtTime(0.0001, now + offset);
    gain.gain.exponentialRampToValueAtTime(0.4, now + offset + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + offset + 0.22);
    osc.connect(gain).connect(audioCtx.destination);
    osc.start(now + offset);
    osc.stop(now + offset + 0.25);
  });
}

function updateAlertsButton() {
  const on = audioCtx && audioCtx.state === 'running';
  enableAlertsBtn.textContent = on ? '🔔 Som ligado (clique pra testar)' : '🔔 Ativar som de pedido novo';
  enableAlertsBtn.classList.toggle('btn-accent', !on);
  enableAlertsBtn.classList.toggle('btn-outline', !!on);
}

enableAlertsBtn.addEventListener('click', async () => {
  if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  await audioCtx.resume();
  try {
    localStorage.setItem(ALERTS_KEY, '1');
  } catch {
    // sem armazenamento — só não lembra.
  }
  if ('Notification' in window && Notification.permission === 'default') {
    await Notification.requestPermission();
  }
  beep();
  updateAlertsButton();
});

// Se já ativou antes, religa no primeiro clique em qualquer lugar do painel.
try {
  if (localStorage.getItem(ALERTS_KEY) === '1') {
    document.addEventListener(
      'click',
      () => {
        if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
        audioCtx.resume().then(updateAlertsButton);
      },
      { once: true }
    );
  }
} catch {
  // ignora
}

function notifyNewOrder(order) {
  beep();
  if ('Notification' in window && Notification.permission === 'granted' && document.hidden) {
    new Notification('🔔 Novo pedido!', {
      body: `${order.customer_name} — ${currency(order.total)} (${order.fulfillment_type === 'delivery' ? 'entrega' : 'retirada'})`,
      tag: order.id,
    });
  }
  const base = document.title.replace(/^\(\d+\) /, '');
  document.title = `(${freshIds.size}) ${base}`;
}

document.addEventListener('visibilitychange', () => {
  if (!document.hidden) document.title = document.title.replace(/^\(\d+\) /, '');
});

// ---------------- Quadro ----------------
function formatAddress(address) {
  if (!address) return '';
  const parts = [[address.street, address.number].filter(Boolean).join(', '), address.neighborhood, address.city].filter(Boolean);
  let text = parts.join(' — ');
  if (address.complement) text += ` — ${address.complement}`;
  if (address.reference) text += ` (ref: ${address.reference})`;
  return text;
}

function paymentDetail(order) {
  let label = PAYMENT_LABELS[order.payment_method] || order.payment_method;
  if (order.payment_method === 'dinheiro') {
    label += order.needs_change ? ` — troco para ${currency(order.change_for)}` : ' — sem troco';
  }
  return label;
}

function itemHtml(i) {
  const addons = (i.selected_addons || [])
    .map((a) => (a.free ? `${esc(a.addon_name)} <span class="free">(grátis)</span>` : esc(a.addon_name)))
    .join(', ');
  return `<li><strong>${esc(i.quantity)}x ${esc(i.product_name)}</strong>${i.size_name ? ` · ${esc(i.size_name)}` : ''}
    ${addons ? `<span class="item-addons">+ ${addons}</span>` : ''}</li>`;
}

// Link do WhatsApp da loja pro cliente, já com a mensagem do status atual.
function whatsappLink(phone, text) {
  return waLink(phone, text);
}

function storeName() {
  return document.getElementById('panelStoreLabel')?.textContent || 'nossa loja';
}

function orderCard(order) {
  const items = orderItemsByOrder.get(order.id) || [];
  const next = nextStatus(order);
  const isTerminal = order.status === 'completed' || order.status === 'cancelled';

  return `
    <div class="order-card status-${esc(order.status)}${freshIds.has(order.id) ? ' is-new' : ''}" data-order-id="${esc(order.id)}">
      <div class="order-card-header">
        <span class="order-status-badge">${order.order_number ? `#${esc(order.order_number)} · ` : ""}${esc(STATUS_LABELS[order.status])}</span>
        <span class="order-time">${new Date(order.created_at).toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })}</span>
      </div>
      <div class="order-customer">
        <strong>${esc(order.customer_name)}</strong>
        <a href="${esc(whatsappLink(order.customer_phone))}" target="_blank" rel="noopener">${esc(formatBrazilPhone(order.customer_phone))} ↗</a>
      </div>
      <div class="order-fulfillment">
        ${order.fulfillment_type === 'delivery' ? `🛵 Entrega — ${esc(formatAddress(order.address))}` : '🏪 Retirar na loja'}
      </div>
      <div class="order-payment">${esc(paymentDetail(order))}</div>
      <ul class="order-items-list">${items.map(itemHtml).join('')}</ul>
      ${order.notes ? `<div class="order-notes">Obs: ${esc(order.notes)}</div>` : ''}
      <div class="order-total">Total: ${currency(order.total)}${Number(order.delivery_fee) > 0 ? ` <small>(entrega ${currency(order.delivery_fee)})</small>` : ''}</div>
      <div class="order-actions">
        ${next ? `<button class="btn btn-primary btn-sm" data-advance="${esc(order.id)}">${esc(NEXT_ACTION_LABEL[next])}</button>` : ''}
        ${!isTerminal ? `<button class="btn btn-outline btn-sm" data-cancel="${esc(order.id)}">${order.status === "received" ? "Não chegou" : "Cancelar"}</button>` : ""}
        <a class="btn btn-whatsapp btn-sm" target="_blank" rel="noopener" href="${esc(whatsappLink(order.customer_phone, statusMessage(order, storeName())))}">💬 Avisar cliente</a>
      </div>
    </div>`;
}

// Venda só conta depois do aceite (mesma regra do Caixa): "received" é pedido
// registrado que pode não ter chegado no WhatsApp.
const SALE_STATUSES = new Set(['preparing', 'ready', 'out_for_delivery', 'completed']);

function renderCounters() {
  const awaiting = orders.filter((o) => o.status === 'received');
  const active = orders.filter((o) => o.status !== 'completed' && o.status !== 'cancelled' && o.status !== 'received');
  const todayKey = new Date().toLocaleDateString('pt-BR');
  const today = orders.filter((o) => SALE_STATUSES.has(o.status) && new Date(o.created_at).toLocaleDateString('pt-BR') === todayKey);
  const todayTotal = today.reduce((s, o) => s + Number(o.total), 0);
  ordersCounters.innerHTML = `
    ${awaiting.length ? `<span>Aguardando aceite: <strong>${awaiting.length}</strong></span>` : ""}
    <span>Em andamento: <strong>${active.length}</strong></span>
    <span>Pedidos hoje: <strong>${today.length}</strong></span>
    <span>Vendido hoje: <strong>${currency(todayTotal)}</strong></span>`;
}

function renderOrders() {
  renderCounters();
  if (orders.length === 0) {
    ordersBoard.innerHTML = '<p class="admin-list-empty">Nenhum pedido por enquanto. Quando chegar, aparece aqui na hora.</p>';
    return;
  }
  const active = orders.filter((o) => o.status !== 'completed' && o.status !== 'cancelled');
  const done = orders.filter((o) => o.status === 'completed' || o.status === 'cancelled');
  ordersBoard.innerHTML =
    (active.length ? active.map(orderCard).join('') : '<p class="admin-list-empty">Nenhum pedido em andamento.</p>') +
    (done.length ? `<h3 class="orders-section-title">Finalizados</h3>${done.map(orderCard).join('')}` : '');
}

async function loadOrderItems(orderIds, targetMap = orderItemsByOrder) {
  if (orderIds.length === 0) return targetMap;
  const { data } = await supabase.from('acai_order_items').select('*').in('order_id', orderIds).order('sort_order');
  for (const item of data || []) {
    if (!targetMap.has(item.order_id)) targetMap.set(item.order_id, []);
    targetMap.get(item.order_id).push(item);
  }
  return targetMap;
}

// Token de carga: se duas cargas ficarem em voo, só a mais recente vale (e
// cada uma monta seu próprio Map — evita itens duplicados na tela).
async function loadOrders() {
  const myToken = ++ordersLoadToken;
  const since = new Date(Date.now() - BOARD_WINDOW_HOURS * 3600 * 1000).toISOString();
  const { data, error } = await supabase
    .from('acai_orders')
    .select('*')
    .eq('store_id', await getStoreId())
    .gte('created_at', since)
    .order('created_at', { ascending: false });
  if (myToken !== ordersLoadToken) return;
  if (error) {
    ordersBoard.innerHTML = '<p class="admin-list-empty">Não foi possível carregar os pedidos.</p>';
    return;
  }
  const freshOrders = data || [];
  const freshItems = await loadOrderItems(freshOrders.map((o) => o.id), new Map());
  if (myToken !== ordersLoadToken) return;
  orders = freshOrders;
  orderItemsByOrder = freshItems;
  renderOrders();
}

async function handleOrderChange(payload) {
  if (payload.eventType === 'INSERT') {
    if (orders.some((o) => o.id === payload.new.id)) return;
    orders = [payload.new, ...orders];
    freshIds.add(payload.new.id);
    // Os itens entram na mesma transação do pedido, mas o evento pode chegar
    // antes da leitura enxergar — tenta de novo rapidinho se vier vazio.
    await loadOrderItems([payload.new.id]);
    if (!orderItemsByOrder.get(payload.new.id)) {
      await new Promise((r) => setTimeout(r, 800));
      await loadOrderItems([payload.new.id]);
    }
    notifyNewOrder(payload.new);
    setTimeout(() => freshIds.delete(payload.new.id), 60000);
  } else if (payload.eventType === 'UPDATE') {
    orders = orders.map((o) => (o.id === payload.new.id ? payload.new : o));
  } else if (payload.eventType === 'DELETE') {
    orders = orders.filter((o) => o.id !== payload.old.id);
  }
  renderOrders();
}

async function subscribeRealtime() {
  if (channel) return;
  const storeId = await getStoreId();
  if (channel) return;
  channel = supabase
    .channel(`acai-orders-${storeId}`)
    .on('postgres_changes', { event: '*', schema: 'public', table: 'acai_orders', filter: `store_id=eq.${storeId}` }, handleOrderChange)
    .subscribe((status) => {
      // Reconectou depois de queda de internet: recarrega pra não perder pedido.
      if (status === 'SUBSCRIBED') loadOrders();
    });
}

ordersBoard.addEventListener('click', async (e) => {
  const advanceBtn = e.target.closest('[data-advance]');
  const cancelBtn = e.target.closest('[data-cancel]');
  if (advanceBtn) {
    const order = orders.find((o) => o.id === advanceBtn.dataset.advance);
    const next = order && nextStatus(order);
    if (!next) return;
    advanceBtn.disabled = true;
    freshIds.delete(order.id);
    const { error } = await supabase.from('acai_orders').update({ status: next, updated_at: new Date().toISOString() }).eq('id', order.id);
    if (error) {
      advanceBtn.disabled = false;
      alert('Não foi possível atualizar o pedido. Confira a internet e tente de novo.');
    }
  } else if (cancelBtn) {
    const target = orders.find((o) => o.id === cancelBtn.dataset.cancel);
    const question =
      target?.status === 'received'
        ? 'A mensagem desse pedido não chegou no WhatsApp? Ele vai pra "Cancelado" e não entra no caixa.'
        : 'Cancelar este pedido?';
    if (!confirm(question)) return;
    const { error } = await supabase
      .from('acai_orders')
      .update({ status: 'cancelled', updated_at: new Date().toISOString() })
      .eq('id', cancelBtn.dataset.cancel);
    if (error) alert('Não foi possível cancelar o pedido.');
  }
});

// Só carrega depois que admin.js confirmar que essa conta é admin da loja.
window.addEventListener('admin:ready', async () => {
  updateAlertsButton();
  await loadOrders();
  await subscribeRealtime();
});

if (isConfigured) {
  supabase.auth.onAuthStateChange((event) => {
    if (event === 'SIGNED_OUT' && channel) {
      supabase.removeChannel(channel);
      channel = null;
    }
  });
}

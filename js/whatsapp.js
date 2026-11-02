// Sem emoji fora do básico: o redirecionamento do wa.me troca emoji tipo
// 👤🛵💵 por "�" na mensagem. Negrito (*texto*) funciona.
//
// Pedido pelo WhatsApp do próprio cliente (link wa.me, igual ao Descascaê):
// o pedido é registrado no banco (painel/caixa) e o WhatsApp abre com a
// mensagem pronta pra loja — o cliente só aperta enviar.
import { currency } from './pricing.js';

export function waLink(number, text) {
  const digits = String(number || '').replace(/\D/g, '');
  return `https://wa.me/${digits}${text ? `?text=${encodeURIComponent(text)}` : ''}`;
}

const PAYMENT_TEXT = {
  cartao_maquininha: 'Cartão (maquininha)',
  pix_maquininha: 'Pix',
  dinheiro: 'Dinheiro',
};

export function paymentText(method, needsChange, changeFor) {
  let text = PAYMENT_TEXT[method] || method;
  if (method === 'dinheiro') text += needsChange && changeFor ? ` — troco para ${currency(changeFor)}` : ' — sem troco';
  return text;
}

export function addressText(a) {
  if (!a) return '';
  let text = [[a.street, a.number].filter(Boolean).join(', '), a.neighborhood, a.city].filter(Boolean).join(' — ');
  if (a.complement) text += ` (${a.complement})`;
  if (a.reference) text += `\nReferência: ${a.reference}`;
  return text;
}

function addonsText(addons) {
  return addons.map((a) => (a.free ? `${a.name} (grátis)` : a.name)).join(', ');
}

// items: [{ quantity, name, size, lineTotal, addons: [{ name, free }] }]
export function buildOrderMessage(o) {
  const lines = [];
  lines.push(`*Pedido${o.orderNumber ? ` #${o.orderNumber}` : ''} — ${o.storeName}*`);
  lines.push('');
  lines.push(`*Cliente:* ${o.customerName}`);
  if (o.customerPhone) lines.push(`*Telefone:* ${o.customerPhone}`);
  lines.push(o.fulfillment === 'delivery' ? `*Entrega:* ${addressText(o.address)}` : '*Retirar na loja*');
  lines.push('');
  lines.push('*Itens:*');
  for (const i of o.items) {
    lines.push(`• ${i.quantity}x ${i.name}${i.size ? ` (${i.size})` : ''} — ${currency(i.lineTotal)}`);
    if (i.addons.length) lines.push(`   + ${addonsText(i.addons)}`);
  }
  lines.push('');
  lines.push(`Subtotal: ${currency(o.subtotal)}`);
  if (o.fulfillment === 'delivery') lines.push(`Entrega: ${Number(o.deliveryFee) > 0 ? currency(o.deliveryFee) : 'grátis'}`);
  lines.push(`*Total: ${currency(o.total)}*`);
  lines.push(`*Pagamento:* ${o.payment}`);
  if (o.notes) lines.push(`\n*Obs:* ${o.notes}`);
  if (o.trackUrl) lines.push(`\nAcompanhar: ${o.trackUrl}`);
  return lines.join('\n');
}

// Mensagem fica guardada no aparelho pra a página do pedido poder reabrir o
// WhatsApp se o cliente voltar sem ter enviado.
const MSG_KEY = (orderId) => `acai_wa_msg:${orderId}`;

export function saveOrderMessage(orderId, number, text) {
  try {
    localStorage.setItem(MSG_KEY(orderId), JSON.stringify({ number, text }));
  } catch {
    // sem armazenamento — a página do pedido só não reabre a mensagem
  }
}

export function loadOrderMessage(orderId) {
  try {
    return JSON.parse(localStorage.getItem(MSG_KEY(orderId)) || 'null');
  } catch {
    return null;
  }
}

// Mensagem que a LOJA manda pro cliente quando muda o status (botão do painel).
export function statusMessage(order, storeName) {
  const n = order.order_number ? ` #${order.order_number}` : '';
  const first = String(order.customer_name || '').split(' ')[0];
  switch (order.status) {
    case 'received':
    case 'preparing':
      return `Oi, ${first}! Recebemos seu pedido${n} na ${storeName} e já estamos preparando.`;
    case 'ready':
      return `Oi, ${first}! Seu pedido${n} está pronto! Pode vir buscar quando quiser.`;
    case 'out_for_delivery':
      return `Oi, ${first}! Seu pedido${n} saiu para entrega! Já já chega aí!`;
    case 'completed':
      return `Obrigado pela preferência, ${first}! Volte sempre na ${storeName}.`;
    case 'cancelled':
      return `Oi, ${first}. Infelizmente precisamos cancelar seu pedido${n}. Qualquer dúvida, é só chamar aqui.`;
    default:
      return '';
  }
}

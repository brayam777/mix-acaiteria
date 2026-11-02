import { supabase, isConfigured } from './supabase-config.js';
import { getStoreId } from './store.js';

// Sempre calcula "agora" no fuso do Brasil (America/Sao_Paulo), independente
// do fuso/relógio do navegador do cliente — evita que alguém com o
// dispositivo configurado errado veja um status de aberto/fechado diferente
// do real horário da loja.
const STORE_TIMEZONE = 'America/Sao_Paulo';

export const DAY_LABELS = [
  'Domingo',
  'Segunda-feira',
  'Terça-feira',
  'Quarta-feira',
  'Quinta-feira',
  'Sexta-feira',
  'Sábado',
];

let cache = null;

export async function loadBusinessHours() {
  if (cache) return cache;
  if (!isConfigured) {
    cache = [];
    return cache;
  }
  const storeId = await getStoreId();
  const { data, error } = await supabase.from('acai_business_hours').select('*').eq('store_id', storeId).order('day_of_week');
  cache = !error && data ? data : [];
  return cache;
}

function nowInStoreTimezone(date = new Date()) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: STORE_TIMEZONE,
    weekday: 'short',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(date);
  const map = Object.fromEntries(parts.map((p) => [p.type, p.value]));
  const weekdayMap = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  return { dayOfWeek: weekdayMap[map.weekday], timeStr: `${map.hour}:${map.minute}:${map.second}` };
}

export function todayHours(hoursList, date = new Date()) {
  const { dayOfWeek } = nowInStoreTimezone(date);
  return hoursList.find((h) => h.day_of_week === dayOfWeek) || null;
}

// Mesma checagem feita no servidor (dentro de create_acai_order) —
// aqui é só pra UX (banner, aviso antecipado); quem decide de verdade se o
// pedido é aceito é o banco.
export function isWithinBusinessHours(hoursList, date = new Date()) {
  const today = todayHours(hoursList, date);
  if (!today || today.is_closed) return false;
  const { timeStr } = nowInStoreTimezone(date);
  return timeStr >= today.opens_at && timeStr < today.closes_at;
}

function formatHm(timeStr) {
  const [h, m] = timeStr.split(':');
  return m === '00' ? `${Number(h)}h` : `${Number(h)}h${m}`;
}

export function todayHoursLabel(hoursList, date = new Date()) {
  const today = todayHours(hoursList, date);
  if (!today || today.is_closed) return 'Hoje a loja não abre';
  return `Hoje (${DAY_LABELS[today.day_of_week]}), funcionamos das ${formatHm(today.opens_at)} às ${formatHm(today.closes_at)}`;
}

import { supabase, isConfigured } from './supabase-config.js';
import { getStoreId } from './store.js';

const DEFAULTS = {
  store_open: true,
  store_name: '',
  store_logo_url: null,
  pickup_enabled: true,
  pickup_address: '',
  whatsapp_number: '',
  // 'gratis' | 'fixo' — quem calcula de verdade é create_acai_order.
  delivery_fee_mode: 'gratis',
  delivery_fixed_fee: 0,
  delivery_city: '',
  delivery_note: '',
};

let cache = null;

export async function loadSettings() {
  if (cache) return cache;
  if (!isConfigured) {
    cache = { ...DEFAULTS };
    return cache;
  }

  const storeId = await getStoreId();
  const { data, error } = await supabase.from('acai_settings').select('key, value').eq('store_id', storeId);
  const result = { ...DEFAULTS };
  if (!error && data) {
    for (const row of data) {
      if (row.value !== null) result[row.key] = row.value;
    }
  }
  cache = result;
  return cache;
}

// Taxa que o cliente vai pagar na entrega (só exibição — o servidor recalcula).
export function deliveryFeeFor(settings) {
  return settings.delivery_fee_mode === 'fixo' ? Math.max(Number(settings.delivery_fixed_fee) || 0, 0) : 0;
}

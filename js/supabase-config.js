import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

// Projeto Supabase da Mix Açaiteria (conta brayamfelipe02 mix). Só a chave
// PÚBLICA (publishable) fica aqui — quem protege os dados é a RLS do banco.
export const SUPABASE_URL = 'https://lezmpssydxuhxoqlwtoc.supabase.co';
export const SUPABASE_ANON_KEY = 'sb_publishable_MoWx9rw2s06hj_zAZWRlWA_TJuTl8cG';

export const isConfigured = SUPABASE_URL !== 'PENDING_SETUP';

export const supabase = isConfigured
  ? createClient(SUPABASE_URL, SUPABASE_ANON_KEY, { auth: { flowType: 'implicit' } })
  : null;

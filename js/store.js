import { supabase } from './supabase-config.js';

// Um deploy só serve todas as açaiterias. A loja sai do endereço:
//   mix.acai.anoteiai.com.br  -> slug "mix"
//   acai.anoteiai.com.br      -> loja padrão (Mix)
//   localhost / *.vercel.app  -> ?loja=<slug> (fica lembrado entre as páginas)
// CUSTOM_DOMAINS liga um domínio próprio do lojista direto a uma loja.
const ROOT_DOMAIN = 'acai.anoteiai.com.br';
const DEFAULT_SLUG = 'mix';
const RESERVED_SUBDOMAINS = new Set(['www']);
const CUSTOM_DOMAINS = {};
const DEV_SLUG_KEY = 'anoteiai_acai_dev_loja';

export function resolveStoreSlug() {
  const host = window.location.hostname.toLowerCase();

  if (CUSTOM_DOMAINS[host]) return CUSTOM_DOMAINS[host];

  if (host.endsWith(`.${ROOT_DOMAIN}`)) {
    const sub = host.slice(0, -(ROOT_DOMAIN.length + 1));
    if (sub && !sub.includes('.') && !RESERVED_SUBDOMAINS.has(sub)) return sub;
  }
  if (host === ROOT_DOMAIN || host === `www.${ROOT_DOMAIN}`) return DEFAULT_SLUG;

  // Ambiente de desenvolvimento/preview.
  const fromUrl = new URLSearchParams(window.location.search).get('loja');
  try {
    if (fromUrl) localStorage.setItem(DEV_SLUG_KEY, fromUrl);
    return fromUrl || localStorage.getItem(DEV_SLUG_KEY) || DEFAULT_SLUG;
  } catch {
    return fromUrl || DEFAULT_SLUG;
  }
}

let cache = null;

// { id, slug, name, status } — ou null se o slug não existe / loja suspensa.
export async function loadStore() {
  if (cache !== null) return cache;
  const { data, error } = await supabase
    .from('acai_stores')
    .select('id, slug, name, status')
    .eq('slug', resolveStoreSlug())
    .maybeSingle();
  cache = !error && data ? data : false;
  return cache;
}

function renderStoreNotFound() {
  document.title = 'Loja não encontrada';
  document.body.innerHTML = `
    <main style="min-height:100vh;display:flex;align-items:center;justify-content:center;padding:24px;text-align:center;font-family:system-ui,sans-serif;">
      <div>
        <h1 style="margin:0 0 8px;">Loja não encontrada</h1>
        <p style="margin:0;opacity:.7;">Confira se o endereço está certo.</p>
      </div>
    </main>`;
}

// Id da loja atual. Se a loja não existe, troca a página inteira por um
// aviso e interrompe quem chamou.
export async function getStoreId() {
  const store = await loadStore();
  if (!store) {
    renderStoreNotFound();
    throw new Error('store_not_found');
  }
  return store.id;
}

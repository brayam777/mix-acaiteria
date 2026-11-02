// Marca Anotei Aí (ícone "comanda") — só no selo do rodapé e no cabeçalho do
// painel. O nome e a logo do cabeçalho do cardápio são os do LOJISTA
// (acai_settings.store_name / store_logo_url, configuráveis no painel).
export function anoteaiMarkSvg(size = 16) {
  return `<svg width="${size}" height="${size}" viewBox="0 0 64 64" fill="none" aria-hidden="true">
    <rect width="64" height="64" rx="14" fill="#241914"/>
    <path d="M14 15 L48 11 Q51 11 51 14 L55 48 Q56 51 53 52 L18 55 Q15 56 15 53 L11 18 Q10 15 14 15 Z" fill="#EFDCB8"/>
    <line x1="20" y1="25" x2="32" y2="23" stroke="#DE4326" stroke-width="2.6" stroke-linecap="round"/>
    <line x1="21" y1="32" x2="36" y2="29" stroke="#DE4326" stroke-width="2.6" stroke-linecap="round"/>
    <circle cx="45" cy="43" r="9" fill="#E8A93A"/>
    <path d="M41 43 L44 46.5 L50.5 38" stroke="#241914" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round" fill="none"/>
  </svg>`;
}

// Preenche o nome/logo do lojista no cabeçalho e no rodapé, e ajusta o
// <title> da página. Chamar depois de loadSettings() em cada página pública.
export function applyStoreBranding(settings, titleBase) {
  const storeName = settings.store_name || document.getElementById('brandName')?.textContent || 'Cardápio digital';

  const nameEl = document.getElementById('brandName');
  if (nameEl) nameEl.textContent = storeName;

  if (settings.store_logo_url) {
    const logoImg = document.getElementById('brandLogoImg');
    const emojiEl = document.getElementById('brandEmoji');
    if (logoImg) {
      logoImg.src = settings.store_logo_url;
      logoImg.alt = storeName;
      logoImg.hidden = false;
    }
    if (emojiEl) emojiEl.hidden = true;
  }

  const heroLogo = document.getElementById('heroLogo');
  if (heroLogo && settings.store_logo_url) {
    heroLogo.src = settings.store_logo_url;
    heroLogo.alt = storeName;
    heroLogo.hidden = false;
  }

  const footerNameEl = document.getElementById('footerStoreName');
  if (footerNameEl) footerNameEl.textContent = storeName;

  const yearEl = document.getElementById('year');
  if (yearEl) yearEl.textContent = new Date().getFullYear();

  if (titleBase) document.title = `${titleBase} — ${storeName}`;
}

// Selo "cardápio via Anotei Aí" do rodapé — visual constante, não depende do lojista.
export function renderBrandBadge() {
  const badge = document.getElementById('brandBadge');
  if (!badge) return;
  badge.innerHTML = `${anoteaiMarkSvg(16)}<span>cardápio via <strong>Anotei Aí</strong></span>`;
}

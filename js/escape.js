// Escapa texto vindo do banco (nomes, descrições, endereços...) antes de ele
// entrar num template de innerHTML. Sem isso, um nome de produto como
// <img src=x onerror=...> executaria código no navegador de quem abre a página.
const ESC_MAP = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;', '`': '&#96;' };

export function esc(value) {
  if (value === null || value === undefined) return '';
  return String(value).replace(/[&<>"'`]/g, (c) => ESC_MAP[c]);
}

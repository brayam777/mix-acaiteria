// Formato exigido pra mandar WhatsApp via uazapi: DDI (55) + DDD (2
// dígitos) + número (8 dígitos fixo ou 9 dígitos celular). Sem DDD a
// mensagem não tem como saber pra qual cidade/número mandar; sem DDI a
// uazapi não entrega. Aceita o número digitado com ou sem o "55" na
// frente (adiciona sozinho se faltar), mas nunca aceita sem DDD.
const BRAZIL_PHONE_RE = /^55[1-9]\d(?:[2-9]\d{7}|9\d{8})$/;

export const PHONE_FORMAT_HINT = 'Informe o número com DDD, assim: (62) 99876-5432.';

// Retorna o número limpo (só dígitos, com "55" na frente) se for um celular
// ou fixo brasileiro válido com DDD — ou null se faltar DDD/DDI ou o
// formato não bater.
export function normalizeBrazilPhone(raw) {
  const digits = (raw || '').replace(/\D/g, '');

  if (digits.length === 12 || digits.length === 13) {
    return digits.startsWith('55') && BRAZIL_PHONE_RE.test(digits) ? digits : null;
  }

  if (digits.length === 10 || digits.length === 11) {
    const withDdi = '55' + digits;
    return BRAZIL_PHONE_RE.test(withDdi) ? withDdi : null;
  }

  return null;
}

// "5562998765432" -> "(62) 99876-5432" (só exibição).
export function formatBrazilPhone(digits) {
  const d = String(digits || '').replace(/\D/g, '').replace(/^55(?=\d{10,11}$)/, '');
  if (d.length === 11) return `(${d.slice(0, 2)}) ${d.slice(2, 7)}-${d.slice(7)}`;
  if (d.length === 10) return `(${d.slice(0, 2)}) ${d.slice(2, 6)}-${d.slice(6)}`;
  return String(digits || '');
}

// Regra de preço do açaí — MESMA lógica de acai_price_item (SQL). O
// navegador só usa isso pra mostrar o preço ao vivo; quem vale é o servidor.
//
//   preço = preço do produto no tamanho escolhido
//         + para cada grupo de adicionais do produto:
//             os N itens MAIS CAROS escolhidos saem grátis (N = cota do
//             grupo naquele produto/tamanho) e o resto é cobrado.
//
// Formatos (montados em catalog.js):
//   link   = { group_id, group_name, min_select, max_select, free_quantity, size_overrides }
//   addon  = { id, name, price, sort_order, size_prices: { [size_id]: price } }

export function groupRule(link, sizeId) {
  const override = (sizeId && link.size_overrides && link.size_overrides[sizeId]) || {};
  const free = override.free_quantity ?? link.free_quantity ?? 0;
  const max = 'max_select' in override ? override.max_select : link.max_select;
  return { min: link.min_select || 0, max: max ?? null, free: Number(free) || 0 };
}

export function addonPrice(addon, sizeId) {
  const bySize = sizeId && addon.size_prices ? addon.size_prices[sizeId] : undefined;
  return Number(bySize ?? addon.price ?? 0);
}

function byPriceDesc(a, b) {
  if (b.price !== a.price) return b.price - a.price;
  if (a.sort_order !== b.sort_order) return a.sort_order - b.sort_order;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

// selectedIds: Set de ids de adicionais escolhidos.
// Retorna { unitPrice, addons, groups, error } — `groups` traz, por grupo,
// a situação da cota pra exibir no modal ("2 grátis · 1 restante").
export function priceItem({ basePrice, sizeId, links, addonsByGroup, selectedIds }) {
  let extra = 0;
  const addons = [];
  const groups = new Map();
  let error = null;

  for (const link of links) {
    const rule = groupRule(link, sizeId);
    const options = addonsByGroup.get(link.group_id) || [];
    const chosen = options
      .filter((a) => selectedIds.has(a.id))
      .map((a) => ({ ...a, price: addonPrice(a, sizeId) }));

    const ranked = [...chosen].sort(byPriceDesc);
    const freeIds = new Set(ranked.slice(0, rule.free).map((a) => a.id));
    const paidCount = chosen.filter((a) => a.price > 0).length;

    for (const a of [...chosen].sort((x, y) => x.sort_order - y.sort_order || (x.id < y.id ? -1 : 1))) {
      const isFree = freeIds.has(a.id);
      if (!isFree) extra += a.price;
      addons.push({
        addonId: a.id,
        addonName: a.name,
        groupId: link.group_id,
        groupName: link.group_name,
        price: a.price,
        free: isFree && a.price > 0,
      });
    }

    const count = chosen.length;
    groups.set(link.group_id, {
      ...rule,
      count,
      freeLeft: Math.max(rule.free - Math.min(paidCount, rule.free), 0),
    });

    if (!error && count < rule.min) {
      error = rule.min === 1 ? `Escolha uma opção em "${link.group_name}".` : `Escolha pelo menos ${rule.min} em "${link.group_name}".`;
    }
    if (!error && rule.max !== null && count > rule.max) {
      error = `Escolha no máximo ${rule.max} em "${link.group_name}".`;
    }
  }

  return { unitPrice: Number(basePrice) + extra, addons, groups, error };
}

export const currency = (v) => Number(v).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });

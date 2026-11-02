import { supabase } from './supabase-config.js';

// Carrega o catálogo inteiro de uma loja e monta os mapas que o cardápio e a
// regra de preço (pricing.js) usam. `onlyAvailable` = visão do cliente.
export async function loadCatalog(storeId, { onlyAvailable = true } = {}) {
  const avail = (q) => (onlyAvailable ? q.eq('is_available', true) : q);
  const [cats, prods, sizes, prodSizes, groups, addons, addonSizePrices, links] = await Promise.all([
    supabase.from('acai_categories').select('*').eq('store_id', storeId).order('sort_order'),
    avail(supabase.from('acai_products').select('*').eq('store_id', storeId)).order('sort_order'),
    supabase.from('acai_sizes').select('*').eq('store_id', storeId).order('sort_order'),
    // Todos os tamanhos (inclusive indisponíveis): produto com tamanho cadastrado
    // nunca cai no preço "sem tamanho" — o cardápio é que esconde os indisponíveis.
    supabase.from('acai_product_sizes').select('*').eq('store_id', storeId),
    supabase.from('acai_addon_groups').select('*').eq('store_id', storeId).order('sort_order'),
    avail(supabase.from('acai_addons').select('*').eq('store_id', storeId)).order('sort_order'),
    supabase.from('acai_addon_size_prices').select('*').eq('store_id', storeId),
    supabase.from('acai_product_addon_groups').select('*').eq('store_id', storeId).order('sort_order'),
  ]);

  const failed = [cats, prods, sizes, prodSizes, groups, addons, addonSizePrices, links].find((r) => r.error);
  if (failed) throw failed.error;

  const sizeById = new Map((sizes.data || []).map((s) => [s.id, s]));
  const groupById = new Map((groups.data || []).map((g) => [g.id, g]));

  // Preços por tamanho de cada produto, na ordem dos tamanhos da loja.
  const sizesByProduct = new Map();
  for (const ps of prodSizes.data || []) {
    const size = sizeById.get(ps.size_id);
    if (!size) continue;
    if (!sizesByProduct.has(ps.product_id)) sizesByProduct.set(ps.product_id, []);
    sizesByProduct.get(ps.product_id).push({
      size_id: ps.size_id,
      name: size.name,
      sort_order: size.sort_order,
      price: Number(ps.price),
      is_available: ps.is_available,
    });
  }
  for (const list of sizesByProduct.values()) list.sort((a, b) => a.sort_order - b.sort_order);

  const sizePricesByAddon = new Map();
  for (const sp of addonSizePrices.data || []) {
    if (!sizePricesByAddon.has(sp.addon_id)) sizePricesByAddon.set(sp.addon_id, {});
    sizePricesByAddon.get(sp.addon_id)[sp.size_id] = Number(sp.price);
  }

  const addonsByGroup = new Map();
  for (const a of addons.data || []) {
    if (!addonsByGroup.has(a.group_id)) addonsByGroup.set(a.group_id, []);
    addonsByGroup.get(a.group_id).push({ ...a, price: Number(a.price), size_prices: sizePricesByAddon.get(a.id) || {} });
  }

  const linksByProduct = new Map();
  for (const l of links.data || []) {
    const group = groupById.get(l.group_id);
    if (!group) continue;
    if (!linksByProduct.has(l.product_id)) linksByProduct.set(l.product_id, []);
    linksByProduct.get(l.product_id).push({ ...l, group_name: group.name, group_sort: group.sort_order });
  }
  for (const list of linksByProduct.values()) list.sort((a, b) => a.sort_order - b.sort_order || a.group_sort - b.group_sort);

  return {
    categories: cats.data || [],
    products: prods.data || [],
    sizes: sizes.data || [],
    groups: groups.data || [],
    sizesByProduct,
    addonsByGroup,
    linksByProduct,
  };
}

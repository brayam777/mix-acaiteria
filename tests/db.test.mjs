// Testes do banco: regra de preço (SQL x JS), pedido, aceite antes da venda,
// caixa, comanda, isolamento entre lojas e permissões.
//   cd tests && npm install && npm test
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import path from 'node:path';
import { createTestDb, ROOT } from './supabase-stubs.mjs';

const { priceItem } = await import(pathToFileURL(path.join(ROOT, 'js', 'pricing.js')).href);

let failures = 0;
const ok = (cond, msg) => {
  if (cond) console.log('  ✓', msg);
  else {
    failures++;
    console.log('  ✗', msg);
  }
};

console.log('Migrações + seed');
const db = await createTestDb();
ok(true, 'aplicadas sem erro');
const key = (await db.query(`select admin_setup_key from acai_store_secrets`)).rows[0];
ok(key && key.admin_setup_key.length === 64, 'loja mix criada com chave de configuração');
await db.exec(readFileSync(path.join(ROOT, 'supabase', 'seed_mix.sql'), 'utf8'));
const prodCount = (await db.query(`select count(*)::int n from acai_products`)).rows[0].n;
ok(prodCount === 16, `16 produtos (rodar o seed 2x não duplica): ${prodCount}`);

const q = async (sql, params = []) => (await db.query(sql, params)).rows;
const store = (await q(`select id from acai_stores where slug = 'mix'`))[0].id;
const sizeId = async (name) => (await q(`select id from acai_sizes where name = $1`, [name]))[0].id;
const prodId = async (name) => (await q(`select id from acai_products where name = $1`, [name]))[0].id;
const addonId = async (group, name) =>
  (await q(`select a.id from acai_addons a join acai_addon_groups g on g.id = a.group_id where g.name = $1 and a.name = $2`, [group, name]))[0].id;

// Mesmo catálogo que o navegador monta (js/catalog.js), lido do banco.
async function jsCatalog() {
  const groups = await q(`select * from acai_addon_groups`);
  const addons = await q(`select * from acai_addons where is_available`);
  const asp = await q(`select * from acai_addon_size_prices`);
  const links = await q(`select * from acai_product_addon_groups order by sort_order`);
  const ps = await q(`select * from acai_product_sizes`);
  const products = await q(`select * from acai_products`);
  const addonsByGroup = new Map();
  for (const a of addons) {
    if (!addonsByGroup.has(a.group_id)) addonsByGroup.set(a.group_id, []);
    const size_prices = Object.fromEntries(asp.filter((x) => x.addon_id === a.id).map((x) => [x.size_id, Number(x.price)]));
    addonsByGroup.get(a.group_id).push({ ...a, price: Number(a.price), size_prices });
  }
  const gname = new Map(groups.map((g) => [g.id, g.name]));
  return { products, ps, links: links.map((l) => ({ ...l, group_name: gname.get(l.group_id) })), addonsByGroup };
}

// Calcula o mesmo item no SQL (acai_price_item) e no JS (pricing.js) e compara.
async function both(label, product, size, addonList, expected) {
  const pid = await prodId(product);
  const sid = size ? await sizeId(size) : null;
  const ids = [];
  for (const [g, n] of addonList) ids.push(await addonId(g, n));

  let sqlPrice = null;
  let sqlErr = null;
  try {
    const r = await q(`select * from acai_price_item($1, $2, $3, $4::uuid[])`, [store, pid, sid, ids]);
    sqlPrice = Number(r[0].unit_price);
  } catch (e) {
    sqlErr = e.message;
  }

  const c = await jsCatalog();
  const prow = c.products.find((p) => p.id === pid);
  const psRow = c.ps.find((x) => x.product_id === pid && x.size_id === sid);
  const js = priceItem({
    basePrice: psRow ? Number(psRow.price) : Number(prow.price),
    sizeId: sid,
    links: c.links.filter((l) => l.product_id === pid),
    addonsByGroup: c.addonsByGroup,
    selectedIds: new Set(ids),
  });

  if (typeof expected === 'number') {
    ok(sqlPrice === expected && js.unitPrice === expected && !js.error, `${label}: SQL ${sqlPrice ?? sqlErr} · JS ${js.unitPrice} · esperado ${expected}`);
  } else {
    // Tamanho/adicional/produto inválido o navegador nem oferece; só o SQL barra.
    const jsMustFail = expected.startsWith('option_');
    ok(sqlErr && sqlErr.includes(expected) && (!jsMustFail || js.error), `${label}: SQL "${sqlErr}"${jsMustFail ? ` · JS "${js.error}"` : ''}`);
  }
}

console.log('Regra de preço (SQL x JS)');
await both('Ninho Cream 500ml + açaí + 3 frutas', 'Ninho Cream', '500ml', [['Base', 'Açaí'], ['Frutas', 'Banana'], ['Frutas', 'Morango'], ['Frutas', 'Uva']], 28);
await both('Ninho Cream 300ml + cupuaçu + 2 frutas', 'Ninho Cream', '300ml', [['Base', 'Cupuaçu'], ['Frutas', 'Banana'], ['Frutas', 'Kiwi']], 20);
await both('Fruty Tropical 300ml + 4 frutas (cota 4)', 'Fruty Tropical', '300ml', [['Frutas', 'Banana'], ['Frutas', 'Morango'], ['Frutas', 'Uva'], ['Frutas', 'Kiwi']], 20);
await both('Mix Essencial 300ml + 2 frutas (cota 1)', 'Mix Essencial', '300ml', [['Base', 'Açaí'], ['Frutas', 'Banana'], ['Frutas', 'Uva']], 18);
await both('Ninho 500ml + Nutella + Kit Kat + calda', 'Ninho Cream', '500ml', [['Base', 'Açaí'], ['Adicionais gourmet', 'Nutella'], ['Adicionais gourmet', 'Kit Kat'], ['Caldas', 'Calda de chocolate']], 41);
await both('Pipoca 500ml + 3 cremes + 1 cobertura', 'Balde de Pipoca Gourmet', '500ml', [['Sabores de creme', 'Nutella'], ['Sabores de creme', 'Creme de Ninho'], ['Sabores de creme', 'Pistache'], ['Coberturas', 'Caramelo']], 38);
await both('Pipoca 350ml + 2 cremes', 'Balde de Pipoca Gourmet', '350ml', [['Sabores de creme', 'Nutella'], ['Sabores de creme', 'Creme de Ninho']], 22);
await both('Pipoca com 1 creme só', 'Balde de Pipoca Gourmet', '500ml', [['Sabores de creme', 'Nutella']], 'option_below_minimum');
await both('Ninho sem escolher a base', 'Ninho Cream', '500ml', [['Frutas', 'Banana']], 'option_below_minimum');
await both('Ninho com açaí E cupuaçu', 'Ninho Cream', '500ml', [['Base', 'Açaí'], ['Base', 'Cupuaçu']], 'option_above_maximum');
await both('Ninho em 350ml (não vende)', 'Ninho Cream', '350ml', [['Base', 'Açaí']], 'invalid_size');
await both('Ninho com creme de pipoca', 'Ninho Cream', '500ml', [['Base', 'Açaí'], ['Sabores de creme', 'Nutella']], 'invalid_option');
await both('Monte do seu jeito (indisponível)', 'Monte do seu jeito', '300ml', [['Base', 'Açaí']], 'product_unavailable');

console.log('Preço por tamanho + cota por tamanho');
const frutas = (await q(`select id from acai_addon_groups where name = 'Frutas'`))[0].id;
const s300 = await sizeId('300ml');
const s500 = await sizeId('500ml');
await db.query(`insert into acai_addon_size_prices (addon_id, size_id, store_id, price) values ($1, $2, $3, 4)`, [await addonId('Adicionais simples', 'Granola'), s500, store]);
await db.query(`update acai_product_addon_groups set size_overrides = $1 where group_id = $2 and product_id = $3`, [
  JSON.stringify({ [s500]: { free_quantity: 3 } }), frutas, await prodId('Cookies Truffle'),
]);
await both('Cookies 500ml + 3 frutas (cota 3 no 500) + granola R$4 no 500', 'Cookies Truffle', '500ml', [['Base', 'Açaí'], ['Frutas', 'Banana'], ['Frutas', 'Morango'], ['Frutas', 'Uva'], ['Adicionais simples', 'Granola']], 29);
await both('Cookies 300ml + 3 frutas (cota 2) + granola R$3', 'Cookies Truffle', '300ml', [['Base', 'Açaí'], ['Frutas', 'Banana'], ['Frutas', 'Morango'], ['Frutas', 'Uva'], ['Adicionais simples', 'Granola']], 26);

console.log('Pedido');
const items = [
  { product_id: await prodId('Ninho Cream'), size_id: s500, quantity: 2, addon_ids: [await addonId('Base', 'Açaí'), await addonId('Frutas', 'Banana'), await addonId('Frutas', 'Morango'), await addonId('Frutas', 'Uva')] },
  { product_id: await prodId('Balde de Pipoca Gourmet'), size_id: await sizeId('350ml'), quantity: 1, addon_ids: [await addonId('Sabores de creme', 'Nutella'), await addonId('Sabores de creme', 'Pistache')] },
];
const PHONE = '5562998765432';
const order = (await q(
  `select * from create_acai_order($1, 'Maria Teste', $2, 'delivery', $3, 'dinheiro', true, 100, 'sem leite em pó', $4)`,
  [store, PHONE, JSON.stringify({ street: 'Rua 1', number: '10', neighborhood: 'Centro', city: 'Mara Rosa' }), JSON.stringify(items)]
))[0];
ok(Number(order.total) === 78 && Number(order.delivery_fee) === 0, `total 2x28 + 22 = 78, frete grátis: ${order.total} / ${order.delivery_fee}`);
const first = (await q(`select status, order_number from acai_orders where id = $1`, [order.order_id]))[0];
ok(first.status === 'received' && first.order_number === 1, `entra como "received" (aguardando aceite) e ganha o #1 do dia`);
const wa = await q(`select * from wa_log order by id`);
ok(wa.length === 1 && wa[0].number === '5562981295475', 'uazapi (se ligada): aviso só pra loja; cliente só depois do aceite');
ok(wa[0].text.includes('• 2x Ninho Cream (500ml)\n   + Açaí, Banana (grátis), Morango (grátis), Uva'), 'itens na ordem do pedido, com grátis marcados');

await db.query(`update acai_settings set value = '"fixo"' where store_id = $1 and key = 'delivery_fee_mode'`, [store]);
await db.query(`update acai_settings set value = '5' where store_id = $1 and key = 'delivery_fixed_fee'`, [store]);
const o2 = (await q(`select * from create_acai_order($1, 'João', $2, 'delivery', $3, 'pix_maquininha', false, null, null, $4)`,
  [store, PHONE, JSON.stringify({ street: 'Rua 2', number: 'S/N', neighborhood: 'Centro' }), JSON.stringify([items[1]])]))[0];
ok(Number(o2.total) === 27, `taxa fixa R$5: total ${o2.total}`);
await db.query(`update acai_settings set value = '"gratis"' where store_id = $1 and key = 'delivery_fee_mode'`, [store]);
ok((await q(`select order_number from acai_orders where id = $1`, [o2.order_id]))[0].order_number === 2, 'segundo pedido do dia é o #2');
const o3 = (await q(`select * from create_acai_order($1, 'Ana', $2, 'pickup', null, 'cartao_maquininha', false, null, null, $3)`,
  [store, PHONE, JSON.stringify([items[1]])]))[0];
ok(Number(o3.total) === 22, `retirada sem frete: ${o3.total}`);

await db.query(`update acai_settings set value = 'false' where store_id = $1 and key = 'pickup_enabled'`, [store]);
try {
  await q(`select * from create_acai_order($1, 'Ana', $2, 'pickup', null, 'pix_maquininha', false, null, null, $3)`, [store, PHONE, JSON.stringify([items[1]])]);
  ok(false, 'retirada desligada deveria falhar');
} catch (e) {
  ok(e.message.includes('pickup_disabled'), 'retirada desligada é recusada');
}
await db.query(`update acai_settings set value = 'true' where store_id = $1 and key = 'pickup_enabled'`, [store]);
try {
  await q(`select * from create_acai_order($1, 'Ana', '6299876', 'pickup', null, 'pix_maquininha', false, null, null, $2)`, [store, JSON.stringify([items[1]])]);
  ok(false, 'telefone inválido deveria falhar');
} catch (e) {
  ok(e.message.includes('invalid_phone_format'), 'telefone sem DDD é recusado');
}
const adulterado = (await q(`select * from create_acai_order($1, 'Ana', $2, 'pickup', null, 'pix_maquininha', false, null, null, $3)`,
  [store, PHONE, JSON.stringify([{ ...items[0], unit_price: 0.01, addon_ids: [items[0].addon_ids[0]] }])]))[0];
ok(Number(adulterado.total) === 50, `preço vindo do navegador é ignorado (servidor cobrou ${adulterado.total} = 2x25)`);

console.log('Aceite, status e comanda');
const agentKey = (await q(`select print_agent_key from acai_store_secrets where store_id = $1`, [store]))[0].print_agent_key;
ok((await q(`select * from get_acai_orders_to_print($1)`, [agentKey])).length === 0, 'comanda não imprime pedido ainda não aceito');
await db.query(`update acai_orders set status = 'preparing' where id = $1`, [order.order_id]);
ok((await q(`select text from wa_log order by id desc limit 1`))[0].text.includes('pedido confirmado'), 'aceitar avisa o cliente (se uazapi ligada)');
await db.query(`update acai_orders set status = 'out_for_delivery' where id = $1`, [order.order_id]);
ok((await q(`select text from wa_log order by id desc limit 1`))[0].text.includes('saiu para entrega'), 'saiu pra entrega avisa o cliente');
const st = (await q(`select * from get_acai_order_status($1)`, [order.order_id]))[0];
ok(st.order_number === 1 && st.items.length === 2 && st.items[0].selected_addons.some((a) => a.free), 'acompanhamento traz número e itens com grátis');
const toPrint = await q(`select * from get_acai_orders_to_print($1)`, [agentKey]);
const maria = toPrint.find((o) => o.order_id === order.order_id);
ok(maria && maria.items[0].product_name === 'Ninho Cream 500ml', `comanda depois do aceite: "${maria?.items[0].product_name}" + ${maria?.items[0].selected_options.map((o) => o.option_name).join(', ')}`);
ok((await q(`select * from get_acai_orders_to_print('chave-errada')`)).length === 0, 'chave errada não vê pedido');

console.log('Caixa');
const uid = '11111111-1111-1111-1111-111111111111';
await db.query(`insert into auth.users values ($1, 'shirley@teste.com')`, [uid]);
try {
  await q(`select get_acai_cash_summary($1, current_date - 1, current_date + 1)`, [store]);
  ok(false, 'resumo sem login deveria falhar');
} catch (e) {
  ok(e.message.includes('not_authorized'), 'resumo do caixa exige admin');
}
await db.query(`select set_config('test.uid', $1, false)`, [uid]);
await q(`select claim_acai_admin($1, $2)`, [store, key.admin_setup_key]);
ok((await q(`select count(*)::int n from acai_admins`))[0].n === 1, 'claim com a chave cria o admin');
try {
  await q(`select claim_acai_admin($1, $2)`, [store, key.admin_setup_key]);
  ok(false, 'segundo claim deveria falhar');
} catch (e) {
  ok(e.message.includes('admin_already_claimed'), 'segundo claim é recusado');
}
await db.query(`update acai_orders set status = 'cancelled' where id = $1`, [o3.order_id]);
await db.query(`update acai_orders set status = 'preparing' where id in ($1, $2)`, [o2.order_id, adulterado.order_id]); // Shirley aceitou
const naoEnviado = (await q(`select * from create_acai_order($1, 'Desistiu', $2, 'pickup', null, 'pix_maquininha', false, null, null, $3)`,
  [store, PHONE, JSON.stringify([items[1]])]))[0];
const cats = await q(`select id, name from acai_cash_categories where store_id = $1`, [store]);
await db.query(`insert into acai_cash_entries (store_id, category_id, kind, amount, payment_method) values ($1, $2, 'expense', 40, 'dinheiro'), ($1, $3, 'income', 15, 'pix')`,
  [store, cats.find((c) => c.name.startsWith('Insumos')).id, cats.find((c) => c.name === 'Venda balcão').id]);
const today = (await q(`select (now() at time zone 'America/Sao_Paulo')::date::text d`))[0].d;
const sum = (await q(`select get_acai_cash_summary($1, $2::date, $2::date) s`, [store, today]))[0].s;
ok(Number(sum.sales_total) === 78 + 27 + 50, `vendas = só aceitos: ${sum.sales_total} (esperado 155)`);
ok(Number(sum.awaiting_total) === 22 && sum.awaiting_count === 1, 'não aceito fica fora, em "aguardando aceite"');
ok(Number(sum.cancelled_total) === 22 && sum.cancelled_count === 1, 'cancelado fica fora, separado');
ok(Number(sum.expense_total) === 40 && Number(sum.income_total) === 15, 'despesa 40 / entrada 15');
const profit = Number(sum.sales_total) + Number(sum.income_total) - Number(sum.expense_total);
ok(profit === 130, `lucro = ${profit}`);
ok(Number(sum.sales_by_payment.dinheiro) === 78 && Number(sum.sales_by_payment.pix_maquininha) === 77, 'vendas por forma de pagamento');
ok(sum.top_products[0].name === 'Ninho Cream 500ml', `mais vendido: ${sum.top_products[0].name}`);

console.log('Rotina da madrugada');
await db.query(`update acai_orders set created_at = now() - interval '2 days' where id in ($1, $2)`, [o2.order_id, naoEnviado.order_id]);
await q(`select acai_close_stale_orders()`);
ok((await q(`select status from acai_orders where id = $1`, [o2.order_id]))[0].status === 'completed', 'aceito esquecido aberto vira concluído');
ok((await q(`select status from acai_orders where id = $1`, [naoEnviado.order_id]))[0].status === 'cancelled', 'não aceito vira cancelado (não entra no caixa)');

console.log('Isolamento entre lojas');
const other = (await q(`select * from create_acai_store('outra', 'Outra Açaiteria')`))[0].store_id;
const otherSize = (await q(`insert into acai_sizes (store_id, name) values ($1, '1L') returning id`, [other]))[0].id;
try {
  await db.query(`insert into acai_product_sizes (product_id, size_id, store_id, price) values ($1, $2, $3, 10)`, [await prodId('Ninho Cream'), otherSize, store]);
  ok(false, 'ligar produto a tamanho de outra loja deveria falhar');
} catch (e) {
  ok(e.message.includes('cross_store_reference'), 'produto não liga em tamanho de outra loja');
}
try {
  await q(`select * from acai_price_item($1, $2, $3, '{}'::uuid[])`, [other, await prodId('Ninho Cream'), s300]);
  ok(false, 'produto de outra loja deveria falhar');
} catch (e) {
  ok(e.message.includes('product_unavailable'), 'pedido não usa produto de outra loja');
}

console.log('Permissões (papel anon)');
await db.query(`select set_config('test.uid', '', false)`);
await db.exec(`set role anon`);
const anonProducts = (await q(`select count(*)::int n from acai_products`))[0].n;
const anonOrders = (await q(`select count(*)::int n from acai_orders`))[0].n;
const anonCash = (await q(`select count(*)::int n from acai_cash_entries`))[0].n;
const anonToken = (await q(`select count(*)::int n from acai_integrations`))[0].n;
ok(anonProducts > 0 && anonOrders === 0 && anonCash === 0 && anonToken === 0, `anon vê cardápio (${anonProducts}), não vê pedidos/caixa/token`);
await db.query(`update acai_products set description = 'hack'`);
ok((await q(`select count(*)::int n from acai_products where description = 'hack'`))[0].n === 0, 'anon não altera produto');
try {
  await q(`select * from create_acai_order($1, 'Anon', $2, 'pickup', null, 'pix_maquininha', false, null, null, $3)`, [store, PHONE, JSON.stringify([items[1]])]);
  ok(true, 'anon faz pedido pela RPC');
} catch (e) {
  ok(false, 'anon fazendo pedido: ' + e.message);
}
for (const fn of [`acai_price_item($1, $2, $3, '{}'::uuid[])`, `acai_send_whatsapp('1', 'x')`]) {
  try {
    await q(`select ${fn}`, fn.startsWith('acai_price') ? [store, await prodId('Ninho Cream'), s300] : []);
    ok(false, `anon não deveria chamar ${fn}`);
  } catch (e) {
    ok(e.message.includes('permission denied'), `anon não chama ${fn.split('(')[0]}`);
  }
}
await db.exec(`reset role`);

console.log(failures ? `\n${failures} FALHA(S)` : '\nTUDO OK');
process.exit(failures ? 1 : 0);

-- Seed da Mix Açaiteria (Mara Rosa-GO) — cardápio transcrito das artes do
-- Instagram (pasta referencias/). Rodar UMA vez no SQL Editor, depois da
-- migração 20261008000000_acai_init.sql. Se a loja já tiver produtos, não
-- mexe em nada. No fim, mostra a chave de configuração do painel.
--
-- Preço do "Monte do seu jeito" ainda não foi passado pela loja: o produto
-- entra INDISPONÍVEL com preço provisório — a Shirley ajusta e ativa no painel.

do $$
declare
  v_store uuid;
  s300 uuid; s350 uuid; s500 uuid;
  c_classicos uuid; c_acai uuid; c_monte uuid; c_pipoca uuid;
  g_base uuid; g_frutas uuid; g_simples uuid; g_gourmet uuid; g_caldas uuid; g_cremes uuid; g_cobert uuid;
  v_prod uuid;
  v_sort int := 0;
  r record;
begin
  select id into v_store from public.acai_stores where slug = 'mix';
  if v_store is null then
    select t.store_id into v_store from public.create_acai_store('mix', 'Mix Açaiteria') t;
  end if;

  if exists (select 1 from public.acai_products where store_id = v_store) then
    raise notice 'Mix já tem catálogo — seed ignorado.';
    return;
  end if;

  -- ---------- Configurações ----------
  insert into public.acai_settings (store_id, key, value) values
    (v_store, 'store_name', '"Mix Açaiteria"'),
    (v_store, 'store_logo_url', '"img/logo.jpeg"'),
    (v_store, 'whatsapp_number', '"5562981295475"'),
    (v_store, 'pickup_enabled', 'true'),
    (v_store, 'delivery_fee_mode', '"gratis"'),
    (v_store, 'delivery_fixed_fee', '0'),
    (v_store, 'delivery_city', '"Mara Rosa"'),
    (v_store, 'delivery_note', '"Entrega grátis em Mara Rosa"')
  on conflict (store_id, key) do update set value = excluded.value, updated_at = now();

  -- ---------- Tamanhos ----------
  insert into public.acai_sizes (store_id, name, sort_order) values (v_store, '300ml', 0) returning id into s300;
  insert into public.acai_sizes (store_id, name, sort_order) values (v_store, '350ml', 1) returning id into s350;
  insert into public.acai_sizes (store_id, name, sort_order) values (v_store, '500ml', 2) returning id into s500;

  -- ---------- Categorias ----------
  insert into public.acai_categories (store_id, name, sort_order) values (v_store, 'Clássicos da Mix', 0) returning id into c_classicos;
  insert into public.acai_categories (store_id, name, sort_order) values (v_store, 'Açaí & Cupuaçu', 1) returning id into c_acai;
  insert into public.acai_categories (store_id, name, sort_order) values (v_store, 'Monte do seu jeito', 2) returning id into c_monte;
  insert into public.acai_categories (store_id, name, sort_order) values (v_store, 'Mix Pipoca', 3) returning id into c_pipoca;

  -- ---------- Grupos de adicionais (biblioteca da loja) ----------
  insert into public.acai_addon_groups (store_id, name, sort_order) values (v_store, 'Base', 0) returning id into g_base;
  insert into public.acai_addon_groups (store_id, name, sort_order) values (v_store, 'Frutas', 1) returning id into g_frutas;
  insert into public.acai_addon_groups (store_id, name, sort_order) values (v_store, 'Adicionais simples', 2) returning id into g_simples;
  insert into public.acai_addon_groups (store_id, name, sort_order) values (v_store, 'Adicionais gourmet', 3) returning id into g_gourmet;
  insert into public.acai_addon_groups (store_id, name, sort_order) values (v_store, 'Caldas', 4) returning id into g_caldas;
  insert into public.acai_addon_groups (store_id, name, sort_order) values (v_store, 'Sabores de creme', 5) returning id into g_cremes;
  insert into public.acai_addon_groups (store_id, name, sort_order) values (v_store, 'Coberturas', 6) returning id into g_cobert;

  insert into public.acai_addons (group_id, store_id, name, price, sort_order)
  select g_base, v_store, n, 0, o from (values ('Açaí', 0), ('Cupuaçu', 1)) x(n, o);

  insert into public.acai_addons (group_id, store_id, name, price, sort_order)
  select g_frutas, v_store, n, 3, o from (values ('Banana', 0), ('Morango', 1), ('Uva', 2), ('Kiwi', 3)) x(n, o);

  insert into public.acai_addons (group_id, store_id, name, price, sort_order)
  select g_simples, v_store, n, 3, o from (values
    ('Granulado (chocolate ou colorido)', 0), ('Leite condensado', 1), ('Granola', 2), ('Paçoca', 3),
    ('Confete (M&M)', 4), ('Chocobol', 5), ('Amendoim', 6), ('Gotas de chocolate', 7),
    ('Jujuba', 8), ('Cereal', 9), ('Bolacha Oreo', 10), ('Cereja em calda', 11)
  ) x(n, o);

  insert into public.acai_addons (group_id, store_id, name, price, sort_order)
  select g_gourmet, v_store, n, p, o from (values
    ('Creme de Ninho', 8, 0), ('Creme de Cookies', 8, 1), ('Nutella', 8, 2), ('Creme de Bis Branco', 8, 3),
    ('Creme de Paçoca', 8, 4), ('Creme de Pistache', 8, 5), ('Kit Kat', 5, 6),
    ('Sonho de Valsa ou Ouro Branco', 3, 7), ('Batom', 3, 8), ('Ovomaltine', 3, 9),
    ('Fini (banana, beijinho ou azedinho)', 5, 10)
  ) x(n, p, o);

  insert into public.acai_addons (group_id, store_id, name, price, sort_order)
  select g_caldas, v_store, n, 3, o from (values
    ('Calda de chocolate', 0), ('Calda de morango', 1), ('Calda de maracujá', 2),
    ('Calda de pistache', 3), ('Calda de caramelo', 4), ('Banana caramelada', 5)
  ) x(n, o);

  insert into public.acai_addons (group_id, store_id, name, price, sort_order)
  select g_cremes, v_store, n, 7, o from (values
    ('Creme de Ninho', 0), ('Nutella', 1), ('Creme de Paçoca', 2), ('Creme de Cookies', 3),
    ('Creme de Morango', 4), ('Creme de Bis Branco', 5), ('Pistache', 6)
  ) x(n, o);

  insert into public.acai_addons (group_id, store_id, name, price, sort_order)
  select g_cobert, v_store, n, 3, o from (values
    ('Chocolate', 0), ('Morango', 1), ('Maracujá', 2), ('Pistache', 3), ('Caramelo', 4), ('Banana caramelada', 5)
  ) x(n, o);

  -- ---------- Açaís (300ml / 500ml) ----------
  -- base: escolhe Açaí ou Cupuaçu (obrigatório); frutas: quantas saem grátis.
  for r in
    select * from (values
      ('classicos', 'Mix Completo', 'A combinação perfeita pra saciar a vontade! Açaí ou cupuaçu, 2 frutas fresquinhas, leite condensado, leite em pó e granola crocante.', 20.00, 25.00, true, 2, false),
      ('classicos', 'Casadinho dos Deuses', 'A união perfeita entre açaí e cupuaçu! Cremosos e irresistíveis, com 2 frutas, leite condensado, leite em pó e granola crocante.', 20.00, 25.00, false, 2, false),
      ('classicos', 'Mix Essencial', 'Pra quem gosta do sabor puro e delicioso! Açaí ou cupuaçu cremoso, 1 fruta fresquinha e granola crocante pra completar.', 15.00, 20.00, true, 1, false),
      ('acai', 'Ninho Cream', 'Açaí ou cupuaçu cremoso, envolvido em um delicioso creme de Ninho, 2 frutas fresquinhas e finalizado com leite em pó.', 20.00, 25.00, true, 2, false),
      ('acai', 'Nutella Supreme', 'Uma explosão de cremosidade! Açaí ou cupuaçu, 2 frutas à sua escolha, Nutella irresistível, leite condensado e uma generosa finalização com leite em pó.', 20.00, 25.00, true, 2, false),
      ('acai', 'Choco Bis Blanc', 'Pra apaixonados por chocolate branco! Açaí cremoso, delicioso creme de chocolate Bis Branco, 2 frutas frescas e uma camada delicada de leite em pó.', 23.00, 28.00, false, 2, true),
      ('acai', 'Paçoca Cream', 'O sabor irresistível da paçoca numa versão super cremosa! Açaí, creme de paçoca, 2 frutas fresquinhas e leite em pó.', 20.00, 25.00, false, 2, true),
      ('acai', 'Fruty Tropical', 'Leve, colorido e refrescante! Açaí cremoso com 4 frutas frescas, finalizado com a crocância deliciosa da granola.', 20.00, 25.00, false, 4, true),
      ('acai', 'Oreo Crunch', 'Pra quem não resiste a Oreo! Açaí cremoso, creme de Oreo, 2 frutas frescas e finalização com leite em pó. Cremoso, crocante e apaixonante.', 23.00, 28.00, false, 2, true),
      ('acai', 'Cookies Truffle', 'Uma experiência trufada a cada colherada! Açaí ou cupuaçu, 2 frutas, creme de Cookies, leite condensado e leite em pó.', 20.00, 25.00, true, 2, false),
      ('acai', 'Ovomaltine Supreme', 'Pros amantes de Ovomaltine! Açaí ou cupuaçu cremoso, 2 frutas, Ovomaltine crocante, leite condensado e leite em pó.', 20.00, 25.00, true, 2, false),
      ('acai', 'Dois Amores Premium', 'Uma dupla impossível de resistir! Açaí ou cupuaçu, 2 frutas, Nutella e creme de Ninho, leite condensado e leite em pó.', 20.00, 25.00, true, 2, false),
      ('acai', 'Napolitano Deluxe', 'Açaí ou cupuaçu cremoso, 2 frutas à sua escolha e três cremes: Nutella, Ninho e Morango, finalizados com leite condensado e leite em pó.', 23.00, 28.00, true, 2, false),
      ('acai', 'Pistache Deluxe', 'O sabor sofisticado que chegou pra conquistar! Açaí ou cupuaçu cremoso com creme de pistache premium, 2 frutas à sua escolha, leite condensado e leite em pó.', 25.00, 30.00, true, 2, true),
      ('monte', 'Monte do seu jeito', 'Escolha a base, as frutas, os adicionais e as caldas e deixe seu açaí do seu jeito!', 15.00, 20.00, true, 0, false)
    ) t(cat, name, descr, p300, p500, has_base, frutas, is_new)
  loop
    insert into public.acai_products (store_id, category_id, name, description, is_available, is_new, sort_order)
    values (
      v_store,
      case r.cat when 'classicos' then c_classicos when 'acai' then c_acai else c_monte end,
      r.name, r.descr,
      r.cat <> 'monte',
      r.is_new,
      v_sort
    )
    returning id into v_prod;
    v_sort := v_sort + 1;

    insert into public.acai_product_sizes (product_id, size_id, store_id, price) values
      (v_prod, s300, v_store, r.p300),
      (v_prod, s500, v_store, r.p500);

    if r.has_base then
      insert into public.acai_product_addon_groups (product_id, group_id, store_id, sort_order, min_select, max_select, free_quantity)
      values (v_prod, g_base, v_store, 0, 1, 1, 0);
    end if;

    insert into public.acai_product_addon_groups (product_id, group_id, store_id, sort_order, min_select, max_select, free_quantity) values
      (v_prod, g_frutas, v_store, 1, 0, null, r.frutas),
      (v_prod, g_simples, v_store, 2, 0, null, 0),
      (v_prod, g_gourmet, v_store, 3, 0, null, 0),
      (v_prod, g_caldas, v_store, 4, 0, null, 0);
  end loop;

  -- ---------- Mix Pipoca ----------
  insert into public.acai_products (store_id, category_id, name, description, sort_order)
  values (v_store, c_pipoca, 'Balde de Pipoca Gourmet',
          'Pipoca gourmet de balde: monte o seu com 2 sabores de creme! Creme adicional R$ 7,00 e coberturas R$ 3,00 cada.',
          v_sort)
  returning id into v_prod;

  insert into public.acai_product_sizes (product_id, size_id, store_id, price) values
    (v_prod, s350, v_store, 22.00),
    (v_prod, s500, v_store, 28.00);

  insert into public.acai_product_addon_groups (product_id, group_id, store_id, sort_order, min_select, max_select, free_quantity) values
    (v_prod, g_cremes, v_store, 0, 2, null, 2),
    (v_prod, g_cobert, v_store, 1, 0, null, 0);
end;
$$;

-- Fotos recortadas das artes (ficam no próprio site, em img/produtos/).
update public.acai_products p set image_url = 'img/produtos/' || v.file
from (values ('Mix Completo', 'mix-completo.jpg'), ('Casadinho dos Deuses', 'casadinho.jpg'),
             ('Mix Essencial', 'mix-essencial.jpg'), ('Balde de Pipoca Gourmet', 'pipoca.jpg')) v(name, file)
where p.name = v.name and p.image_url is null
  and p.store_id = (select id from public.acai_stores where slug = 'mix');

-- Chave pra Shirley criar a conta do painel (admin.html → "Criar conta").
select s.slug, s.name, sec.admin_setup_key
from public.acai_stores s
join public.acai_store_secrets sec on sec.store_id = s.id
where s.slug = 'mix';

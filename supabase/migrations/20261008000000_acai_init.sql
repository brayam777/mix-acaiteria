-- Anotei Aí — Açaí. Cardápio + pedidos + caixa para açaiterias.
--
-- Autossuficiente: roda num projeto Supabase vazio (o da Mix) ou ao lado de
-- outras tabelas — tudo aqui é prefixado acai_. O envio de WhatsApp (uazapi)
-- usa a configuração de acai_integrations, que só o dono do banco mexe.
--
-- Multi-loja desde o início: cada açaiteria é UMA linha em acai_stores e toda
-- tabela da loja tem store_id. Mesmas regras de ouro da hamburgueria:
--   * o público só LÊ catálogo/configuração;
--   * pedido só entra pela função create_acai_order, que recalcula TODOS os
--     preços (tamanho, adicionais grátis/pagos, frete) a partir do catálogo;
--   * escrita no catálogo/pedidos/caixa só pelo admin daquela loja (RLS).
--
-- Modelo de preço do açaí (o que muda em relação à hamburgueria):
--   * produto tem preço por TAMANHO (acai_product_sizes);
--   * adicionais vivem numa biblioteca da loja (acai_addon_groups/acai_addons)
--     e são ligados a cada produto por acai_product_addon_groups, que guarda
--     as regras DAQUELE produto: mínimo, máximo e quantos saem GRÁTIS
--     ("2 frutas à sua escolha"). size_overrides permite mudar cota/máximo
--     por tamanho ({"<size_id>": {"free_quantity": 3, "max_select": 5}});
--   * o preço do adicional pode variar por tamanho (acai_addon_size_prices);
--   * dentro de cada grupo, a cota grátis cobre os itens MAIS CAROS
--     escolhidos (o cliente nunca sai perdendo) e o resto é cobrado.

create extension if not exists pg_net;
create extension if not exists pg_cron;

-- ============================================================
-- WhatsApp (uazapi)
-- ============================================================
-- Sem policy nenhuma: nem anon nem lojista leem o token. Preencher pelo SQL
-- Editor (ver NOVO_CLIENTE.md). Vazio = não manda mensagem, sem travar pedido.
create table if not exists public.acai_integrations (
  key text primary key,
  value text not null default ''
);

alter table public.acai_integrations enable row level security;

insert into public.acai_integrations (key, value) values
  ('uazapi_base_url', ''),
  ('uazapi_token', '')
on conflict (key) do nothing;

create or replace function public.acai_send_whatsapp(p_number text, p_text text)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_base_url text;
  v_token text;
begin
  select value into v_base_url from public.acai_integrations where key = 'uazapi_base_url';
  select value into v_token from public.acai_integrations where key = 'uazapi_token';

  if coalesce(v_base_url, '') = '' or coalesce(v_token, '') = '' or coalesce(p_number, '') = '' then
    return;
  end if;

  begin
    perform net.http_post(
      url := rtrim(v_base_url, '/') || '/send/text',
      headers := jsonb_build_object('Content-Type', 'application/json', 'token', v_token),
      body := jsonb_build_object('number', p_number, 'text', p_text)
    );
  exception when others then
    raise warning 'acai_send_whatsapp failed: %', sqlerrm;
  end;
end;
$$;

-- ============================================================
-- Lojas e acesso
-- ============================================================
create table if not exists public.acai_stores (
  id uuid primary key default gen_random_uuid(),
  slug text not null unique check (slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$'),
  name text not null,
  status text not null default 'active' check (status in ('active', 'trial', 'suspended')),
  created_at timestamptz not null default now()
);

alter table public.acai_stores enable row level security;

create policy "Public can view active acai stores"
  on public.acai_stores for select
  using (status in ('active', 'trial'));

-- Sem policy nenhuma: só funções security definer leem.
create table if not exists public.acai_store_secrets (
  store_id uuid primary key references public.acai_stores(id) on delete cascade,
  admin_setup_key text not null default (replace(gen_random_uuid()::text, '-', '') || replace(gen_random_uuid()::text, '-', '')),
  print_agent_key text not null unique default (replace(gen_random_uuid()::text, '-', '') || replace(gen_random_uuid()::text, '-', '')),
  printer_name text,
  agent_last_seen timestamptz,
  agent_info text
);

alter table public.acai_store_secrets enable row level security;

create table if not exists public.acai_admins (
  store_id uuid not null references public.acai_stores(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  email text,
  created_at timestamptz not null default now(),
  primary key (store_id, user_id)
);

alter table public.acai_admins enable row level security;

create index if not exists acai_admins_user_idx on public.acai_admins (user_id);

create or replace function public.acai_is_store_admin(p_store_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.acai_admins
    where user_id = auth.uid() and store_id = p_store_id
  );
$$;

create policy "Admin can view own acai admin row"
  on public.acai_admins for select
  using (user_id = auth.uid());

-- ============================================================
-- Catálogo
-- ============================================================
create table if not exists public.acai_categories (
  id uuid primary key default gen_random_uuid(),
  store_id uuid not null references public.acai_stores(id) on delete cascade,
  name text not null,
  sort_order integer not null default 0,
  is_active boolean not null default true,
  created_at timestamptz not null default now()
);

create table if not exists public.acai_sizes (
  id uuid primary key default gen_random_uuid(),
  store_id uuid not null references public.acai_stores(id) on delete cascade,
  name text not null,
  sort_order integer not null default 0,
  created_at timestamptz not null default now()
);

create table if not exists public.acai_products (
  id uuid primary key default gen_random_uuid(),
  store_id uuid not null references public.acai_stores(id) on delete cascade,
  category_id uuid references public.acai_categories(id) on delete set null,
  name text not null,
  description text,
  -- Só vale quando o produto NÃO tem tamanhos cadastrados.
  price numeric(10,2) not null default 0 check (price >= 0),
  image_url text,
  is_available boolean not null default true,
  is_new boolean not null default false,
  sort_order integer not null default 0,
  created_at timestamptz not null default now()
);

create table if not exists public.acai_product_sizes (
  product_id uuid not null references public.acai_products(id) on delete cascade,
  size_id uuid not null references public.acai_sizes(id) on delete cascade,
  store_id uuid not null references public.acai_stores(id) on delete cascade,
  price numeric(10,2) not null check (price >= 0),
  is_available boolean not null default true,
  primary key (product_id, size_id)
);

create table if not exists public.acai_addon_groups (
  id uuid primary key default gen_random_uuid(),
  store_id uuid not null references public.acai_stores(id) on delete cascade,
  name text not null,
  sort_order integer not null default 0,
  created_at timestamptz not null default now()
);

create table if not exists public.acai_addons (
  id uuid primary key default gen_random_uuid(),
  group_id uuid not null references public.acai_addon_groups(id) on delete cascade,
  store_id uuid not null references public.acai_stores(id) on delete cascade,
  name text not null,
  price numeric(10,2) not null default 0 check (price >= 0),
  is_available boolean not null default true,
  sort_order integer not null default 0
);

create table if not exists public.acai_addon_size_prices (
  addon_id uuid not null references public.acai_addons(id) on delete cascade,
  size_id uuid not null references public.acai_sizes(id) on delete cascade,
  store_id uuid not null references public.acai_stores(id) on delete cascade,
  price numeric(10,2) not null check (price >= 0),
  primary key (addon_id, size_id)
);

create table if not exists public.acai_product_addon_groups (
  product_id uuid not null references public.acai_products(id) on delete cascade,
  group_id uuid not null references public.acai_addon_groups(id) on delete cascade,
  store_id uuid not null references public.acai_stores(id) on delete cascade,
  sort_order integer not null default 0,
  min_select integer not null default 0,
  max_select integer, -- null = sem limite
  free_quantity integer not null default 0,
  size_overrides jsonb not null default '{}'::jsonb,
  primary key (product_id, group_id),
  constraint acai_pag_bounds check (
    min_select >= 0 and free_quantity >= 0 and (max_select is null or max_select >= min_select)
  )
);

create index if not exists acai_categories_store_idx on public.acai_categories (store_id, sort_order);
create index if not exists acai_sizes_store_idx on public.acai_sizes (store_id, sort_order);
create index if not exists acai_products_store_idx on public.acai_products (store_id, sort_order);
create index if not exists acai_product_sizes_store_idx on public.acai_product_sizes (store_id);
create index if not exists acai_addon_groups_store_idx on public.acai_addon_groups (store_id, sort_order);
create index if not exists acai_addons_group_idx on public.acai_addons (group_id, sort_order);
create index if not exists acai_addons_store_idx on public.acai_addons (store_id);
create index if not exists acai_addon_size_prices_store_idx on public.acai_addon_size_prices (store_id);
create index if not exists acai_pag_store_idx on public.acai_product_addon_groups (store_id);

-- ============================================================
-- Configuração
-- ============================================================
create table if not exists public.acai_settings (
  store_id uuid not null references public.acai_stores(id) on delete cascade,
  key text not null,
  value jsonb,
  updated_at timestamptz not null default now(),
  primary key (store_id, key)
);

create table if not exists public.acai_business_hours (
  store_id uuid not null references public.acai_stores(id) on delete cascade,
  day_of_week smallint not null check (day_of_week between 0 and 6),
  opens_at time not null default '14:00',
  closes_at time not null default '22:00',
  is_closed boolean not null default false,
  primary key (store_id, day_of_week),
  constraint acai_business_hours_order check (is_closed or closes_at > opens_at)
);

-- ============================================================
-- Pedidos
-- ============================================================
create table if not exists public.acai_orders (
  id uuid primary key default gen_random_uuid(),
  store_id uuid not null references public.acai_stores(id) on delete cascade,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  customer_name text not null,
  customer_phone text not null,
  fulfillment_type text not null check (fulfillment_type in ('pickup', 'delivery')),
  address jsonb,
  notes text,
  items_subtotal numeric(10,2) not null default 0,
  delivery_fee numeric(10,2) not null default 0,
  total numeric(10,2) not null default 0,
  status text not null default 'preparing'
    check (status in ('received', 'preparing', 'ready', 'out_for_delivery', 'completed', 'cancelled')),
  payment_method text not null check (payment_method in ('cartao_maquininha', 'pix_maquininha', 'dinheiro')),
  needs_change boolean not null default false,
  change_for numeric(10,2),
  printed_at timestamptz
);

alter table public.acai_orders replica identity full;

create index if not exists acai_orders_store_idx on public.acai_orders (store_id, created_at desc);

create table if not exists public.acai_order_items (
  id uuid primary key default gen_random_uuid(),
  order_id uuid not null references public.acai_orders(id) on delete cascade,
  store_id uuid not null references public.acai_stores(id) on delete cascade,
  product_id uuid references public.acai_products(id) on delete set null,
  product_name text not null,
  size_name text,
  unit_price numeric(10,2) not null,
  quantity integer not null check (quantity > 0),
  -- [{group_name, addon_name, price, free}]
  selected_addons jsonb not null default '[]'::jsonb,
  line_total numeric(10,2) not null,
  sort_order integer not null default 0
);

create index if not exists acai_order_items_order_idx on public.acai_order_items (order_id);
create index if not exists acai_order_items_store_idx on public.acai_order_items (store_id);

-- Testes de impressão pedidos pelo painel (sem policy: só funções mexem).
create table if not exists public.acai_print_tests (
  id uuid primary key default gen_random_uuid(),
  store_id uuid not null references public.acai_stores(id) on delete cascade,
  requested_at timestamptz not null default now(),
  printed_at timestamptz,
  error text
);

alter table public.acai_print_tests enable row level security;

create index if not exists acai_print_tests_store_idx on public.acai_print_tests (store_id, requested_at desc);

-- ============================================================
-- Caixa (despesas e entradas avulsas; as vendas do cardápio entram sozinhas)
-- ============================================================
create table if not exists public.acai_cash_categories (
  id uuid primary key default gen_random_uuid(),
  store_id uuid not null references public.acai_stores(id) on delete cascade,
  name text not null,
  kind text not null check (kind in ('expense', 'income')),
  sort_order integer not null default 0,
  created_at timestamptz not null default now()
);

create table if not exists public.acai_cash_entries (
  id uuid primary key default gen_random_uuid(),
  store_id uuid not null references public.acai_stores(id) on delete cascade,
  category_id uuid references public.acai_cash_categories(id) on delete set null,
  kind text not null check (kind in ('expense', 'income')),
  description text,
  amount numeric(10,2) not null check (amount > 0),
  payment_method text not null default 'dinheiro' check (payment_method in ('dinheiro', 'pix', 'cartao', 'outro')),
  entry_date date not null default ((now() at time zone 'America/Sao_Paulo')::date),
  created_by uuid default auth.uid(),
  created_at timestamptz not null default now()
);

create index if not exists acai_cash_categories_store_idx on public.acai_cash_categories (store_id, kind, sort_order);
create index if not exists acai_cash_entries_store_idx on public.acai_cash_entries (store_id, entry_date desc);

-- ============================================================
-- store_id dos filhos sempre herdado do pai (e validado entre lojas)
-- ============================================================
-- Ignora o store_id que vier do cliente: admin da loja A não consegue
-- pendurar nada num produto/grupo da loja B (o store_id vira o da loja B e
-- a RLS barra). Também impede ligar um produto a tamanho/grupo de OUTRA loja.
create or replace function public.acai_inherit_store_id()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_other uuid;
begin
  if tg_table_name = 'acai_product_sizes' then
    select store_id into new.store_id from public.acai_products where id = new.product_id;
    select store_id into v_other from public.acai_sizes where id = new.size_id;
  elsif tg_table_name = 'acai_addons' then
    select store_id into new.store_id from public.acai_addon_groups where id = new.group_id;
    v_other := new.store_id;
  elsif tg_table_name = 'acai_addon_size_prices' then
    select store_id into new.store_id from public.acai_addons where id = new.addon_id;
    select store_id into v_other from public.acai_sizes where id = new.size_id;
  elsif tg_table_name = 'acai_product_addon_groups' then
    select store_id into new.store_id from public.acai_products where id = new.product_id;
    select store_id into v_other from public.acai_addon_groups where id = new.group_id;
  elsif tg_table_name = 'acai_order_items' then
    select store_id into new.store_id from public.acai_orders where id = new.order_id;
    v_other := new.store_id;
  end if;

  if v_other is distinct from new.store_id then
    raise exception 'cross_store_reference';
  end if;
  return new;
end;
$$;

drop trigger if exists acai_product_sizes_store on public.acai_product_sizes;
create trigger acai_product_sizes_store
  before insert or update on public.acai_product_sizes
  for each row execute function public.acai_inherit_store_id();

drop trigger if exists acai_addons_store on public.acai_addons;
create trigger acai_addons_store
  before insert or update on public.acai_addons
  for each row execute function public.acai_inherit_store_id();

drop trigger if exists acai_addon_size_prices_store on public.acai_addon_size_prices;
create trigger acai_addon_size_prices_store
  before insert or update on public.acai_addon_size_prices
  for each row execute function public.acai_inherit_store_id();

drop trigger if exists acai_product_addon_groups_store on public.acai_product_addon_groups;
create trigger acai_product_addon_groups_store
  before insert or update on public.acai_product_addon_groups
  for each row execute function public.acai_inherit_store_id();

drop trigger if exists acai_order_items_store on public.acai_order_items;
create trigger acai_order_items_store
  before insert or update on public.acai_order_items
  for each row execute function public.acai_inherit_store_id();

-- ============================================================
-- RLS
-- ============================================================
alter table public.acai_categories enable row level security;
alter table public.acai_sizes enable row level security;
alter table public.acai_products enable row level security;
alter table public.acai_product_sizes enable row level security;
alter table public.acai_addon_groups enable row level security;
alter table public.acai_addons enable row level security;
alter table public.acai_addon_size_prices enable row level security;
alter table public.acai_product_addon_groups enable row level security;
alter table public.acai_settings enable row level security;
alter table public.acai_business_hours enable row level security;
alter table public.acai_orders enable row level security;
alter table public.acai_order_items enable row level security;
alter table public.acai_cash_categories enable row level security;
alter table public.acai_cash_entries enable row level security;

-- Leitura pública do catálogo e da configuração (o cardápio precisa).
create policy "Public can view acai categories" on public.acai_categories for select using (true);
create policy "Public can view acai sizes" on public.acai_sizes for select using (true);
create policy "Public can view acai products" on public.acai_products for select using (true);
create policy "Public can view acai product sizes" on public.acai_product_sizes for select using (true);
create policy "Public can view acai addon groups" on public.acai_addon_groups for select using (true);
create policy "Public can view acai addons" on public.acai_addons for select using (true);
create policy "Public can view acai addon size prices" on public.acai_addon_size_prices for select using (true);
create policy "Public can view acai product addon groups" on public.acai_product_addon_groups for select using (true);
create policy "Public can view acai settings" on public.acai_settings for select using (true);
create policy "Public can view acai business hours" on public.acai_business_hours for select using (true);

-- Escrita (e leitura de pedidos/caixa) só pelo admin DESTA loja.
create policy "Admin manages acai categories" on public.acai_categories for all
  using (public.acai_is_store_admin(store_id)) with check (public.acai_is_store_admin(store_id));
create policy "Admin manages acai sizes" on public.acai_sizes for all
  using (public.acai_is_store_admin(store_id)) with check (public.acai_is_store_admin(store_id));
create policy "Admin manages acai products" on public.acai_products for all
  using (public.acai_is_store_admin(store_id)) with check (public.acai_is_store_admin(store_id));
create policy "Admin manages acai product sizes" on public.acai_product_sizes for all
  using (public.acai_is_store_admin(store_id)) with check (public.acai_is_store_admin(store_id));
create policy "Admin manages acai addon groups" on public.acai_addon_groups for all
  using (public.acai_is_store_admin(store_id)) with check (public.acai_is_store_admin(store_id));
create policy "Admin manages acai addons" on public.acai_addons for all
  using (public.acai_is_store_admin(store_id)) with check (public.acai_is_store_admin(store_id));
create policy "Admin manages acai addon size prices" on public.acai_addon_size_prices for all
  using (public.acai_is_store_admin(store_id)) with check (public.acai_is_store_admin(store_id));
create policy "Admin manages acai product addon groups" on public.acai_product_addon_groups for all
  using (public.acai_is_store_admin(store_id)) with check (public.acai_is_store_admin(store_id));
create policy "Admin manages acai settings" on public.acai_settings for all
  using (public.acai_is_store_admin(store_id)) with check (public.acai_is_store_admin(store_id));
create policy "Admin manages acai business hours" on public.acai_business_hours for all
  using (public.acai_is_store_admin(store_id)) with check (public.acai_is_store_admin(store_id));
create policy "Admin manages acai orders" on public.acai_orders for all
  using (public.acai_is_store_admin(store_id)) with check (public.acai_is_store_admin(store_id));
create policy "Admin manages acai order items" on public.acai_order_items for all
  using (public.acai_is_store_admin(store_id)) with check (public.acai_is_store_admin(store_id));
create policy "Admin manages acai cash categories" on public.acai_cash_categories for all
  using (public.acai_is_store_admin(store_id)) with check (public.acai_is_store_admin(store_id));
create policy "Admin manages acai cash entries" on public.acai_cash_entries for all
  using (public.acai_is_store_admin(store_id)) with check (public.acai_is_store_admin(store_id));

-- ============================================================
-- Fotos (bucket público; cada loja escreve só na pasta <store_id>/)
-- ============================================================
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('acai-products', 'acai-products', true, 10485760, array['image/png', 'image/jpeg', 'image/webp'])
on conflict (id) do nothing;

drop policy if exists "Public can view acai product photos" on storage.objects;
create policy "Public can view acai product photos" on storage.objects for select
  using (bucket_id = 'acai-products');

drop policy if exists "Admin can upload acai product photos" on storage.objects;
create policy "Admin can upload acai product photos" on storage.objects for insert
  with check (
    bucket_id = 'acai-products'
    and (storage.foldername(name))[1] in (select store_id::text from public.acai_admins where user_id = auth.uid())
  );

drop policy if exists "Admin can update acai product photos" on storage.objects;
create policy "Admin can update acai product photos" on storage.objects for update
  using (
    bucket_id = 'acai-products'
    and (storage.foldername(name))[1] in (select store_id::text from public.acai_admins where user_id = auth.uid())
  );

drop policy if exists "Admin can delete acai product photos" on storage.objects;
create policy "Admin can delete acai product photos" on storage.objects for delete
  using (
    bucket_id = 'acai-products'
    and (storage.foldername(name))[1] in (select store_id::text from public.acai_admins where user_id = auth.uid())
  );

-- ============================================================
-- Realtime (painel de pedidos)
-- ============================================================
do $$
begin
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'acai_orders'
  ) then
    alter publication supabase_realtime add table public.acai_orders;
  end if;
end;
$$;

-- ============================================================
-- Helpers
-- ============================================================
create or replace function public.acai_setting(p_store_id uuid, p_key text)
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
  select value from public.acai_settings where store_id = p_store_id and key = p_key;
$$;

create or replace function public.acai_store_display_name(p_store_id uuid)
returns text
language sql
stable
security definer
set search_path = public
as $$
  select coalesce(
    nullif(public.acai_setting(p_store_id, 'store_name') #>> '{}', ''),
    (select name from public.acai_stores where id = p_store_id),
    'Loja'
  );
$$;

create or replace function public.acai_money(p_value numeric)
returns text
language sql
stable
as $$
  select replace(to_char(coalesce(p_value, 0), 'FM999999990.00'), '.', ',');
$$;

-- Resumo dos itens pra WhatsApp/comanda:
--   • 1x Ninho Cream (500ml)
--     + Açaí, Banana, Morango (grátis), Nutella
create or replace function public.acai_items_summary(p_order_id uuid)
returns text
language sql
stable
security definer
set search_path = public
as $$
  select coalesce(string_agg(t.line, E'\n' order by t.sort_order), '')
  from (
    select oi.sort_order,
      format('• %sx %s%s', oi.quantity, oi.product_name, coalesce(' (' || oi.size_name || ')', ''))
      || coalesce(E'\n   + ' || (
        select string_agg(a ->> 'addon_name' || case when (a ->> 'free')::boolean then ' (grátis)' else '' end, ', ')
        from jsonb_array_elements(oi.selected_addons) a
      ), '') as line
    from public.acai_order_items oi
    where oi.order_id = p_order_id
  ) t;
$$;

-- ============================================================
-- Preço de UM item (regra do açaí). Mesma lógica de js/pricing.js — o
-- servidor é quem vale; o navegador só mostra.
-- ============================================================
create or replace function public.acai_price_item(
  p_store_id uuid,
  p_product_id uuid,
  p_size_id uuid,
  p_addon_ids uuid[]
)
returns table (product_name text, size_name text, unit_price numeric, selected_addons jsonb)
language plpgsql
stable
security definer
set search_path = public
as $$
#variable_conflict use_variable
declare
  v_product public.acai_products%rowtype;
  v_base numeric;
  v_size_name text;
  v_size_key text := '';
  v_ids uuid[];
  v_invalid int;
  v_link record;
  v_free int;
  v_max int;
  v_count int;
  v_row record;
  v_extra numeric := 0;
  v_addons jsonb := '[]'::jsonb;
begin
  select * into v_product from public.acai_products p where p.id = p_product_id and p.store_id = p_store_id;
  if not found or not v_product.is_available then
    raise exception 'product_unavailable';
  end if;

  if exists (select 1 from public.acai_product_sizes ps where ps.product_id = p_product_id) then
    select ps.price, s.name into v_base, v_size_name
    from public.acai_product_sizes ps
    join public.acai_sizes s on s.id = ps.size_id
    where ps.product_id = p_product_id and ps.size_id = p_size_id and ps.is_available;
    if not found then
      raise exception 'invalid_size';
    end if;
    v_size_key := p_size_id::text;
  else
    v_base := v_product.price;
    v_size_name := null;
  end if;

  select coalesce(array_agg(distinct x), array[]::uuid[]) into v_ids
  from unnest(coalesce(p_addon_ids, array[]::uuid[])) x;

  -- Todo adicional precisa estar disponível E num grupo ligado a este produto.
  select count(*) into v_invalid
  from unnest(v_ids) sel(addon_id)
  where not exists (
    select 1
    from public.acai_addons a
    join public.acai_product_addon_groups pag on pag.group_id = a.group_id and pag.product_id = p_product_id
    where a.id = sel.addon_id and a.is_available
  );
  if v_invalid > 0 then
    raise exception 'invalid_option';
  end if;

  for v_link in
    select pag.*, g.name as group_name, g.sort_order as group_sort
    from public.acai_product_addon_groups pag
    join public.acai_addon_groups g on g.id = pag.group_id
    where pag.product_id = p_product_id
    order by pag.sort_order, g.sort_order
  loop
    v_free := coalesce((v_link.size_overrides -> v_size_key ->> 'free_quantity')::int, v_link.free_quantity);
    v_max := case
      when v_size_key <> '' and (v_link.size_overrides -> v_size_key) ? 'max_select'
        then (v_link.size_overrides -> v_size_key ->> 'max_select')::int
      else v_link.max_select
    end;

    select count(*) into v_count
    from public.acai_addons a
    where a.group_id = v_link.group_id and a.id = any(v_ids);

    if v_count < v_link.min_select then
      raise exception 'option_below_minimum: %', v_link.group_name;
    end if;
    if v_max is not null and v_count > v_max then
      raise exception 'option_above_maximum: %', v_link.group_name;
    end if;

    for v_row in
      select x.name, x.price, x.rn
      from (
        select a.name, a.sort_order, a.id,
               coalesce(asp.price, a.price) as price,
               row_number() over (order by coalesce(asp.price, a.price) desc, a.sort_order, a.id) as rn
        from public.acai_addons a
        left join public.acai_addon_size_prices asp on asp.addon_id = a.id and asp.size_id = p_size_id
        where a.group_id = v_link.group_id and a.id = any(v_ids)
      ) x
      order by x.sort_order, x.id
    loop
      v_addons := v_addons || jsonb_build_object(
        'group_name', v_link.group_name,
        'addon_name', v_row.name,
        'price', v_row.price,
        'free', v_row.rn <= v_free and v_row.price > 0
      );
      if v_row.rn > v_free then
        v_extra := v_extra + v_row.price;
      end if;
    end loop;
  end loop;

  return query select v_product.name, v_size_name, v_base + v_extra, v_addons;
end;
$$;

-- ============================================================
-- Pedido
-- ============================================================
create or replace function public.create_acai_order(
  p_store_id uuid,
  p_customer_name text,
  p_customer_phone text,
  p_fulfillment_type text,
  p_address jsonb,
  p_payment_method text,
  p_needs_change boolean,
  p_change_for numeric,
  p_notes text,
  p_items jsonb
)
returns table (order_id uuid, items_subtotal numeric, delivery_fee numeric, total numeric)
language plpgsql
security definer
set search_path = public
as $$
#variable_conflict use_variable
declare
  v_customer_phone text;
  v_now_local timestamp;
  v_hours public.acai_business_hours%rowtype;
  v_fee_mode text;
  v_delivery_fee numeric := 0;
  v_subtotal numeric := 0;
  v_order_id uuid;
  v_order_row public.acai_orders%rowtype;
  v_item jsonb;
  v_quantity int;
  v_size_id uuid;
  v_addon_ids uuid[];
  v_priced record;
  v_position int := 0;
begin
  if not exists (select 1 from public.acai_stores s where s.id = p_store_id and s.status in ('active', 'trial')) then
    raise exception 'store_not_found';
  end if;

  if p_customer_name is null or length(trim(p_customer_name)) = 0 then
    raise exception 'missing_customer_name';
  end if;
  if p_customer_phone is null or length(trim(p_customer_phone)) = 0 then
    raise exception 'missing_customer_phone';
  end if;

  v_customer_phone := regexp_replace(p_customer_phone, '\D', '', 'g');
  if v_customer_phone !~ '^55[1-9][0-9](?:[2-9][0-9]{7}|9[0-9]{8})$' then
    raise exception 'invalid_phone_format';
  end if;

  if p_fulfillment_type not in ('pickup', 'delivery') then
    raise exception 'invalid_fulfillment_type';
  end if;
  if p_fulfillment_type = 'pickup'
     and coalesce((public.acai_setting(p_store_id, 'pickup_enabled') #>> '{}')::boolean, true) = false then
    raise exception 'pickup_disabled';
  end if;
  if p_fulfillment_type = 'delivery' and (p_address is null or coalesce(trim(p_address ->> 'street'), '') = '') then
    raise exception 'address_required';
  end if;
  if p_payment_method not in ('cartao_maquininha', 'pix_maquininha', 'dinheiro') then
    raise exception 'invalid_payment_method';
  end if;
  if p_items is null or jsonb_typeof(p_items) <> 'array' or jsonb_array_length(p_items) = 0 then
    raise exception 'empty_order';
  end if;
  if jsonb_array_length(p_items) > 50 then
    raise exception 'too_many_items';
  end if;

  if coalesce((public.acai_setting(p_store_id, 'store_open') #>> '{}')::boolean, true) = false then
    raise exception 'store_closed';
  end if;

  v_now_local := now() at time zone 'America/Sao_Paulo';
  select * into v_hours from public.acai_business_hours h
  where h.store_id = p_store_id and h.day_of_week = extract(dow from v_now_local)::smallint;
  if not found or v_hours.is_closed
     or v_now_local::time < v_hours.opens_at
     or v_now_local::time >= v_hours.closes_at
  then
    raise exception 'outside_business_hours';
  end if;

  -- Frete: grátis (padrão) ou taxa fixa. Nada vindo do navegador entra aqui.
  if p_fulfillment_type = 'delivery' then
    v_fee_mode := coalesce(public.acai_setting(p_store_id, 'delivery_fee_mode') #>> '{}', 'gratis');
    if v_fee_mode = 'fixo' then
      v_delivery_fee := greatest(coalesce((public.acai_setting(p_store_id, 'delivery_fixed_fee') #>> '{}')::numeric, 0), 0);
    end if;
  end if;

  insert into public.acai_orders (
    store_id, customer_name, customer_phone, fulfillment_type, address, notes,
    items_subtotal, delivery_fee, total, status,
    payment_method, needs_change, change_for
  ) values (
    p_store_id, trim(p_customer_name), v_customer_phone, p_fulfillment_type,
    case when p_fulfillment_type = 'delivery' then p_address else null end,
    nullif(trim(coalesce(p_notes, '')), ''),
    0, v_delivery_fee, v_delivery_fee, 'preparing',
    p_payment_method, coalesce(p_needs_change, false) and p_payment_method = 'dinheiro',
    case when coalesce(p_needs_change, false) and p_payment_method = 'dinheiro' then p_change_for else null end
  )
  returning id into v_order_id;

  for v_item in select * from jsonb_array_elements(p_items)
  loop
    v_quantity := coalesce((v_item ->> 'quantity')::int, 0);
    if v_quantity < 1 or v_quantity > 99 then
      raise exception 'invalid_quantity';
    end if;

    v_size_id := nullif(v_item ->> 'size_id', '')::uuid;

    select coalesce(array_agg(elem::uuid), array[]::uuid[]) into v_addon_ids
    from jsonb_array_elements_text(coalesce(v_item -> 'addon_ids', '[]'::jsonb)) elem;

    select * into v_priced
    from public.acai_price_item(p_store_id, (v_item ->> 'product_id')::uuid, v_size_id, v_addon_ids);

    insert into public.acai_order_items (
      store_id, order_id, product_id, product_name, size_name, unit_price, quantity, selected_addons, line_total, sort_order
    ) values (
      p_store_id, v_order_id, (v_item ->> 'product_id')::uuid, v_priced.product_name, v_priced.size_name,
      v_priced.unit_price, v_quantity, v_priced.selected_addons, v_priced.unit_price * v_quantity, v_position
    );

    v_subtotal := v_subtotal + v_priced.unit_price * v_quantity;
    v_position := v_position + 1;
  end loop;

  update public.acai_orders o
  set items_subtotal = v_subtotal, total = v_subtotal + v_delivery_fee, updated_at = now()
  where o.id = v_order_id
  returning * into v_order_row;

  perform public.acai_notify_new_order(v_order_id);
  perform public.acai_notify_client_status(v_order_row);

  return query select v_order_id, v_subtotal, v_delivery_fee, v_subtotal + v_delivery_fee;
end;
$$;

-- ============================================================
-- WhatsApp: mensagens de pedido
-- ============================================================
create or replace function public.acai_payment_label(p_order public.acai_orders)
returns text
language sql
stable
as $$
  select case p_order.payment_method
    when 'cartao_maquininha' then '💳 Cartão na maquininha'
    when 'pix_maquininha' then '📱 PIX na maquininha'
    else '💵 Dinheiro' || case
      when p_order.needs_change then ' — troco para R$ ' || public.acai_money(p_order.change_for)
      else ' — sem troco'
    end
  end;
$$;

create or replace function public.acai_address_text(p_address jsonb)
returns text
language plpgsql
immutable
as $$
declare
  v_text text;
begin
  if p_address is null then
    return '';
  end if;
  v_text := concat_ws(', ',
    nullif(concat_ws(' ', p_address ->> 'street', p_address ->> 'number'), ''),
    nullif(p_address ->> 'neighborhood', ''),
    nullif(p_address ->> 'city', '')
  );
  if nullif(p_address ->> 'complement', '') is not null then
    v_text := v_text || ' — ' || (p_address ->> 'complement');
  end if;
  if nullif(p_address ->> 'reference', '') is not null then
    v_text := v_text || format(' (ref: %s)', p_address ->> 'reference');
  end if;
  return v_text;
end;
$$;

create or replace function public.acai_notify_new_order(p_order_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_order public.acai_orders%rowtype;
begin
  select * into v_order from public.acai_orders where id = p_order_id;
  if not found then
    return;
  end if;

  perform public.acai_send_whatsapp(
    public.acai_setting(v_order.store_id, 'whatsapp_number') #>> '{}',
    format(
      E'🔔 Novo pedido — %s\n\nCliente: %s\nTelefone: %s\n%s\n\nItens:\n%s\n%s\nTotal: R$ %s\nPagamento: %s',
      public.acai_store_display_name(v_order.store_id),
      v_order.customer_name,
      v_order.customer_phone,
      case when v_order.fulfillment_type = 'delivery'
        then '🛵 Entrega — ' || public.acai_address_text(v_order.address)
        else '🏪 Retirar na loja' end,
      public.acai_items_summary(p_order_id),
      case when coalesce(v_order.notes, '') <> '' then format(E'Obs: %s\n', v_order.notes) else '' end,
      public.acai_money(v_order.total),
      public.acai_payment_label(v_order)
    )
  );
end;
$$;

create or replace function public.acai_notify_client_status(p_order public.acai_orders)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_store_name text := public.acai_store_display_name(p_order.store_id);
  v_message text;
begin
  if p_order.status = 'preparing' then
    v_message := format(
      E'💜 *%s* — pedido confirmado, %s! Já vamos começar a preparar.\n\n%s\n%s\n\nItens:\n%s\n%s\nTotal: R$ %s\n\nResponde *Ok* pra confirmar que recebeu 👍',
      v_store_name,
      p_order.customer_name,
      case when p_order.fulfillment_type = 'delivery'
        then '🛵 Entrega — ' || public.acai_address_text(p_order.address)
        else '🏪 Retirar na loja' end,
      public.acai_payment_label(p_order),
      public.acai_items_summary(p_order.id),
      case when coalesce(p_order.notes, '') <> '' then format(E'Obs: %s\n', p_order.notes) else '' end,
      public.acai_money(p_order.total)
    );
  elsif p_order.status = 'ready' and p_order.fulfillment_type = 'pickup' then
    v_message := format(E'✅ *%s* — seu pedido está pronto! Pode vir buscar quando quiser.', v_store_name);
  elsif p_order.status = 'out_for_delivery' then
    v_message := format(E'🛵 *%s* — seu pedido saiu para entrega! Já está a caminho até você.', v_store_name);
  else
    return;
  end if;

  perform public.acai_send_whatsapp(p_order.customer_phone, v_message);
end;
$$;

create or replace function public.acai_notify_order_status()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.status is distinct from old.status then
    perform public.acai_notify_client_status(new);
  end if;
  return new;
end;
$$;

drop trigger if exists acai_orders_notify_status on public.acai_orders;
create trigger acai_orders_notify_status
  after update on public.acai_orders
  for each row execute function public.acai_notify_order_status();

-- ============================================================
-- Acompanhamento pelo cliente
-- ============================================================
create or replace function public.get_acai_order_status(p_order_id uuid)
returns table (
  status text,
  fulfillment_type text,
  items_subtotal numeric,
  delivery_fee numeric,
  total numeric,
  payment_method text,
  needs_change boolean,
  change_for numeric,
  created_at timestamptz,
  items jsonb
)
language sql
stable
security definer
set search_path = public
as $$
  select o.status, o.fulfillment_type, o.items_subtotal, o.delivery_fee, o.total,
         o.payment_method, o.needs_change, o.change_for, o.created_at,
         coalesce((
           select jsonb_agg(jsonb_build_object(
             'product_name', oi.product_name, 'size_name', oi.size_name, 'quantity', oi.quantity,
             'line_total', oi.line_total, 'selected_addons', oi.selected_addons
           ) order by oi.sort_order)
           from public.acai_order_items oi where oi.order_id = o.id
         ), '[]'::jsonb)
  from public.acai_orders o
  where o.id = p_order_id;
$$;

create or replace function public.get_acai_orders_by_customer(
  p_store_id uuid,
  p_customer_name text,
  p_customer_phone text
)
returns table (order_id uuid, status text, fulfillment_type text, total numeric, created_at timestamptz)
language sql
stable
security definer
set search_path = public
as $$
  select id, status, fulfillment_type, total, created_at
  from public.acai_orders
  where store_id = p_store_id
    and lower(trim(customer_name)) = lower(trim(p_customer_name))
    and customer_phone = regexp_replace(p_customer_phone, '\D', '', 'g')
    and created_at > now() - interval '90 days'
  order by created_at desc
  limit 10;
$$;

-- ============================================================
-- Admin: cadastro self-service (chave de configuração da loja)
-- ============================================================
create or replace function public.acai_admin_claimed(p_store_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (select 1 from public.acai_admins where store_id = p_store_id);
$$;

create or replace function public.claim_acai_admin(p_store_id uuid, p_setup_key text)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_stored_key text;
begin
  if auth.uid() is null then
    raise exception 'not_authenticated';
  end if;
  if exists (select 1 from public.acai_admins where store_id = p_store_id) then
    raise exception 'admin_already_claimed';
  end if;

  select admin_setup_key into v_stored_key from public.acai_store_secrets where store_id = p_store_id;
  if coalesce(v_stored_key, '') = '' or p_setup_key is distinct from v_stored_key then
    raise exception 'invalid_setup_key';
  end if;

  insert into public.acai_admins (store_id, user_id, email)
  values (p_store_id, auth.uid(), auth.jwt() ->> 'email');
end;
$$;

-- ============================================================
-- Impressão automática (mesmo agente da hamburgueria, RPCs acai_)
-- ============================================================
-- O agente imprime product_name + selected_options[].option_name; aqui o
-- tamanho vai junto do nome e cada adicional vira uma "opção".
create or replace function public.get_acai_orders_to_print(p_agent_key text)
returns table (
  order_id uuid,
  customer_name text,
  customer_phone text,
  fulfillment_type text,
  address jsonb,
  payment_method text,
  needs_change boolean,
  change_for numeric,
  notes text,
  total numeric,
  created_at timestamptz,
  items jsonb
)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_store_id uuid;
begin
  if coalesce(p_agent_key, '') = '' then
    return;
  end if;
  select s.store_id into v_store_id from public.acai_store_secrets s where s.print_agent_key = p_agent_key;
  if v_store_id is null then
    return;
  end if;

  return query
  select
    o.id, o.customer_name, o.customer_phone, o.fulfillment_type, o.address, o.payment_method,
    o.needs_change, o.change_for, o.notes, o.total, o.created_at,
    coalesce((
      select jsonb_agg(jsonb_build_object(
        'product_name', oi.product_name || coalesce(' ' || oi.size_name, ''),
        'quantity', oi.quantity,
        'selected_options', coalesce((
          select jsonb_agg(jsonb_build_object(
            'option_name', (a ->> 'addon_name') || case when (a ->> 'free')::boolean then ' (gratis)' else '' end
          ))
          from jsonb_array_elements(oi.selected_addons) a
        ), '[]'::jsonb)
      ) order by oi.sort_order)
      from public.acai_order_items oi where oi.order_id = o.id
    ), '[]'::jsonb)
  from public.acai_orders o
  where o.store_id = v_store_id
    and o.printed_at is null
    and o.status <> 'cancelled'
  order by o.created_at asc;
end;
$$;

create or replace function public.mark_acai_order_printed(p_agent_key text, p_order_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_store_id uuid;
begin
  if coalesce(p_agent_key, '') = '' then
    return;
  end if;
  select s.store_id into v_store_id from public.acai_store_secrets s where s.print_agent_key = p_agent_key;
  if v_store_id is null then
    return;
  end if;
  update public.acai_orders set printed_at = now() where id = p_order_id and store_id = v_store_id;
end;
$$;

create or replace function public.get_acai_agent_tasks(p_agent_key text, p_agent_info text default null)
returns table (printer_name text, test_id uuid)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_store_id uuid;
  v_printer text;
  v_test uuid;
begin
  if coalesce(p_agent_key, '') = '' then
    return;
  end if;
  select s.store_id, s.printer_name into v_store_id, v_printer
  from public.acai_store_secrets s where s.print_agent_key = p_agent_key;
  if v_store_id is null then
    return;
  end if;

  update public.acai_store_secrets
  set agent_last_seen = now(), agent_info = coalesce(p_agent_info, agent_info)
  where store_id = v_store_id
    and (agent_last_seen is null or agent_last_seen < now() - interval '20 seconds');

  select t.id into v_test
  from public.acai_print_tests t
  where t.store_id = v_store_id and t.printed_at is null and t.error is null
    and t.requested_at > now() - interval '5 minutes'
  order by t.requested_at asc limit 1;

  return query select v_printer, v_test;
end;
$$;

create or replace function public.mark_acai_print_test(p_agent_key text, p_test_id uuid, p_error text default null)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_store_id uuid;
begin
  if coalesce(p_agent_key, '') = '' then
    return;
  end if;
  select s.store_id into v_store_id from public.acai_store_secrets s where s.print_agent_key = p_agent_key;
  if v_store_id is null then
    return;
  end if;
  update public.acai_print_tests
  set printed_at = case when p_error is null then now() else printed_at end,
      error = left(p_error, 500)
  where id = p_test_id and store_id = v_store_id;
end;
$$;

create or replace function public.get_acai_print_agent_config(p_store_id uuid)
returns table (store_name text, print_agent_key text)
language plpgsql
security definer
set search_path = public
as $$
begin
  if not public.acai_is_store_admin(p_store_id) then
    raise exception 'not_authorized';
  end if;
  return query
  select public.acai_store_display_name(p_store_id), s.print_agent_key
  from public.acai_store_secrets s where s.store_id = p_store_id;
end;
$$;

create or replace function public.request_acai_print_test(p_store_id uuid)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_id uuid;
begin
  if not public.acai_is_store_admin(p_store_id) then
    raise exception 'not_authorized';
  end if;

  select t.id into v_id
  from public.acai_print_tests t
  where t.store_id = p_store_id and t.printed_at is null and t.error is null
    and t.requested_at > now() - interval '2 minutes'
  order by t.requested_at desc limit 1;

  if v_id is null then
    insert into public.acai_print_tests (store_id) values (p_store_id) returning id into v_id;
  end if;
  return v_id;
end;
$$;

create or replace function public.get_acai_print_status(p_store_id uuid, p_test_id uuid default null)
returns table (agent_last_seen timestamptz, agent_info text, printer_name text, test_printed_at timestamptz, test_error text)
language plpgsql
security definer
set search_path = public
as $$
begin
  if not public.acai_is_store_admin(p_store_id) then
    raise exception 'not_authorized';
  end if;
  return query
  select s.agent_last_seen, s.agent_info, s.printer_name, t.printed_at, t.error
  from public.acai_store_secrets s
  left join public.acai_print_tests t on t.id = p_test_id and t.store_id = s.store_id
  where s.store_id = p_store_id;
end;
$$;

create or replace function public.set_acai_printer_name(p_store_id uuid, p_printer_name text)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if not public.acai_is_store_admin(p_store_id) then
    raise exception 'not_authorized';
  end if;
  update public.acai_store_secrets
  set printer_name = nullif(trim(p_printer_name), '')
  where store_id = p_store_id;
end;
$$;

-- ============================================================
-- Caixa: resumo do período (vendas do cardápio + lançamentos)
-- ============================================================
-- Vendas = pedidos NÃO cancelados do período (pagamento é na entrega, e o
-- cron fecha os esquecidos de madrugada). Os ainda em andamento aparecem
-- separados em "pending" só como informação.
create or replace function public.get_acai_cash_summary(p_store_id uuid, p_from date, p_to date)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_result jsonb;
begin
  if not public.acai_is_store_admin(p_store_id) then
    raise exception 'not_authorized';
  end if;
  if p_from is null or p_to is null or p_to < p_from then
    raise exception 'invalid_period';
  end if;

  with ord as (
    select o.*, (o.created_at at time zone 'America/Sao_Paulo')::date as day
    from public.acai_orders o
    where o.store_id = p_store_id
      and (o.created_at at time zone 'America/Sao_Paulo')::date between p_from and p_to
  ),
  sales as (select * from ord where status <> 'cancelled'),
  ent as (
    select e.*, c.name as category_name
    from public.acai_cash_entries e
    left join public.acai_cash_categories c on c.id = e.category_id
    where e.store_id = p_store_id and e.entry_date between p_from and p_to
  ),
  days as (
    select d::date as day from generate_series(p_from, p_to, interval '1 day') d
  )
  select jsonb_build_object(
    'sales_total', coalesce((select sum(total) from sales), 0),
    'sales_count', (select count(*) from sales),
    'delivery_fees', coalesce((select sum(delivery_fee) from sales), 0),
    'pending_total', coalesce((select sum(total) from sales where status <> 'completed'), 0),
    'pending_count', (select count(*) from sales where status <> 'completed'),
    'cancelled_total', coalesce((select sum(total) from ord where status = 'cancelled'), 0),
    'cancelled_count', (select count(*) from ord where status = 'cancelled'),
    'sales_by_payment', coalesce((
      select jsonb_object_agg(payment_method, t) from (
        select payment_method, sum(total) t from sales group by payment_method
      ) x), '{}'::jsonb),
    'income_total', coalesce((select sum(amount) from ent where kind = 'income'), 0),
    'expense_total', coalesce((select sum(amount) from ent where kind = 'expense'), 0),
    'income_by_payment', coalesce((
      select jsonb_object_agg(payment_method, t) from (
        select payment_method, sum(amount) t from ent where kind = 'income' group by payment_method
      ) x), '{}'::jsonb),
    'expense_by_payment', coalesce((
      select jsonb_object_agg(payment_method, t) from (
        select payment_method, sum(amount) t from ent where kind = 'expense' group by payment_method
      ) x), '{}'::jsonb),
    'expenses_by_category', coalesce((
      select jsonb_agg(jsonb_build_object('name', name, 'total', t) order by t desc) from (
        select coalesce(category_name, 'Sem categoria') as name, sum(amount) t
        from ent where kind = 'expense' group by 1
      ) x), '[]'::jsonb),
    'top_products', coalesce((
      select jsonb_agg(jsonb_build_object('name', name, 'quantity', q, 'total', t) order by q desc, t desc) from (
        select oi.product_name || coalesce(' ' || oi.size_name, '') as name, sum(oi.quantity) q, sum(oi.line_total) t
        from public.acai_order_items oi
        join sales s on s.id = oi.order_id
        group by 1
        order by 2 desc, 3 desc
        limit 10
      ) x), '[]'::jsonb),
    'daily', coalesce((
      select jsonb_agg(jsonb_build_object(
        'day', d.day,
        'sales', coalesce((select sum(total) from sales s where s.day = d.day), 0),
        'income', coalesce((select sum(amount) from ent e where e.kind = 'income' and e.entry_date = d.day), 0),
        'expense', coalesce((select sum(amount) from ent e where e.kind = 'expense' and e.entry_date = d.day), 0)
      ) order by d.day)
      from days d), '[]'::jsonb)
  ) into v_result;

  return v_result;
end;
$$;

-- ============================================================
-- Fecha pedidos esquecidos em aberto (mesma rotina da hamburgueria)
-- ============================================================
create or replace function public.acai_close_stale_orders()
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  update public.acai_orders
  set status = 'completed', updated_at = now()
  where status not in ('completed', 'cancelled')
    and (created_at at time zone 'America/Sao_Paulo')::date
        < (now() at time zone 'America/Sao_Paulo')::date;
end;
$$;

select cron.unschedule(jobid) from cron.job where jobname = 'acai-close-stale-orders';
select cron.schedule('acai-close-stale-orders', '5 8 * * *', $$select public.acai_close_stale_orders();$$);

-- ============================================================
-- Onboarding: açaiteria nova = uma chamada (só SQL Editor / service role)
-- ============================================================
create or replace function public.create_acai_store(p_slug text, p_name text)
returns table (store_id uuid, slug text, admin_setup_key text)
language plpgsql
security definer
set search_path = public
as $$
#variable_conflict use_column
declare
  v_store_id uuid;
begin
  insert into public.acai_stores (slug, name)
  values (lower(trim(p_slug)), trim(p_name))
  returning id into v_store_id;

  insert into public.acai_store_secrets (store_id) values (v_store_id);

  insert into public.acai_settings (store_id, key, value) values
    (v_store_id, 'store_name', to_jsonb(trim(p_name))),
    (v_store_id, 'store_logo_url', 'null'),
    (v_store_id, 'store_open', 'true'),
    (v_store_id, 'pickup_enabled', 'true'),
    (v_store_id, 'pickup_address', '""'),
    (v_store_id, 'whatsapp_number', '""'),
    (v_store_id, 'delivery_fee_mode', '"gratis"'),
    (v_store_id, 'delivery_fixed_fee', '0'),
    (v_store_id, 'delivery_city', '""'),
    (v_store_id, 'delivery_note', '""');

  insert into public.acai_business_hours (store_id, day_of_week, opens_at, closes_at)
  select v_store_id, d, '14:00', '22:00' from generate_series(0, 6) d;

  insert into public.acai_cash_categories (store_id, name, kind, sort_order) values
    (v_store_id, 'Insumos (açaí, frutas, complementos)', 'expense', 0),
    (v_store_id, 'Embalagens', 'expense', 1),
    (v_store_id, 'Funcionários', 'expense', 2),
    (v_store_id, 'Aluguel', 'expense', 3),
    (v_store_id, 'Energia / Água', 'expense', 4),
    (v_store_id, 'Gás', 'expense', 5),
    (v_store_id, 'Marketing', 'expense', 6),
    (v_store_id, 'Outros', 'expense', 7),
    (v_store_id, 'Venda balcão', 'income', 0),
    (v_store_id, 'Outras entradas', 'income', 1);

  return query
  select v_store_id, s.slug, sec.admin_setup_key
  from public.acai_stores s
  join public.acai_store_secrets sec on sec.store_id = s.id
  where s.id = v_store_id;
end;
$$;

-- ============================================================
-- Permissões das funções
-- ============================================================
-- Internas: só outras funções security definer / triggers / cron chamam.
revoke all on function public.create_acai_store(text, text) from public, anon, authenticated;
revoke all on function public.acai_send_whatsapp(text, text) from public, anon, authenticated;
revoke all on function public.acai_inherit_store_id() from public, anon, authenticated;
revoke all on function public.acai_setting(uuid, text) from public, anon, authenticated;
revoke all on function public.acai_store_display_name(uuid) from public, anon, authenticated;
revoke all on function public.acai_items_summary(uuid) from public, anon, authenticated;
revoke all on function public.acai_price_item(uuid, uuid, uuid, uuid[]) from public, anon, authenticated;
revoke all on function public.acai_notify_new_order(uuid) from public, anon, authenticated;
revoke all on function public.acai_notify_client_status(public.acai_orders) from public, anon, authenticated;
revoke all on function public.acai_notify_order_status() from public, anon, authenticated;
revoke all on function public.acai_close_stale_orders() from public, anon, authenticated;

-- Públicas (cardápio, acompanhamento, agente de impressão com chave).
grant execute on function public.create_acai_order(uuid, text, text, text, jsonb, text, boolean, numeric, text, jsonb) to anon, authenticated;
grant execute on function public.get_acai_order_status(uuid) to anon, authenticated;
grant execute on function public.get_acai_orders_by_customer(uuid, text, text) to anon, authenticated;
grant execute on function public.acai_admin_claimed(uuid) to anon, authenticated;
grant execute on function public.get_acai_orders_to_print(text) to anon, authenticated;
grant execute on function public.mark_acai_order_printed(text, uuid) to anon, authenticated;
grant execute on function public.get_acai_agent_tasks(text, text) to anon, authenticated;
grant execute on function public.mark_acai_print_test(text, uuid, text) to anon, authenticated;

-- Só lojista logado (cada uma confere acai_is_store_admin por dentro).
revoke all on function public.claim_acai_admin(uuid, text) from public, anon;
revoke all on function public.get_acai_print_agent_config(uuid) from public, anon;
revoke all on function public.request_acai_print_test(uuid) from public, anon;
revoke all on function public.get_acai_print_status(uuid, uuid) from public, anon;
revoke all on function public.set_acai_printer_name(uuid, text) from public, anon;
revoke all on function public.get_acai_cash_summary(uuid, date, date) from public, anon;
grant execute on function public.claim_acai_admin(uuid, text) to authenticated;
grant execute on function public.get_acai_print_agent_config(uuid) to authenticated;
grant execute on function public.request_acai_print_test(uuid) to authenticated;
grant execute on function public.get_acai_print_status(uuid, uuid) to authenticated;
grant execute on function public.set_acai_printer_name(uuid, text) to authenticated;
grant execute on function public.get_acai_cash_summary(uuid, date, date) to authenticated;

-- Pedido pelo WhatsApp: o pedido é registrado ANTES de o cliente mandar a
-- mensagem. Então ele entra como "received" (Novo pedido, aguardando aceite) e
-- só vira venda quando a loja toca em Aceitar (preparing) — quem desistiu no
-- WhatsApp nunca entra no caixa.
--   * create_acai_order: status inicial received
--   * caixa: vendas = preparing/ready/out_for_delivery/completed; received à parte
--   * madrugada: received do dia anterior vira cancelled (não concluído)
--   * comanda só imprime depois do aceite

alter table public.acai_orders alter column status set default 'received';

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
    0, v_delivery_fee, v_delivery_fee, 'received',
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
  sales as (select * from ord where status in ('preparing', 'ready', 'out_for_delivery', 'completed')),
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
    'awaiting_total', coalesce((select sum(total) from ord where status = 'received'), 0),
    'awaiting_count', (select count(*) from ord where status = 'received'),
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

create or replace function public.acai_close_stale_orders()
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  -- Não aceito até o dia seguinte = o cliente não mandou a mensagem: cancela
  -- (não entra no caixa). O resto que ficou aberto foi entregue: conclui.
  update public.acai_orders
  set status = 'cancelled', updated_at = now()
  where status = 'received'
    and (created_at at time zone 'America/Sao_Paulo')::date
        < (now() at time zone 'America/Sao_Paulo')::date;

  update public.acai_orders
  set status = 'completed', updated_at = now()
  where status not in ('completed', 'cancelled')
    and (created_at at time zone 'America/Sao_Paulo')::date
        < (now() at time zone 'America/Sao_Paulo')::date;
end;
$$;

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
    and o.status not in ('received', 'cancelled')
  order by o.created_at asc;
end;
$$;

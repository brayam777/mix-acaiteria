-- Pedido vai pro WhatsApp da loja pelo próprio cliente (link wa.me, igual ao
-- Descascaê). Cada pedido ganha um número do dia (#1, #2...) por loja, pra
-- Shirley bater a mensagem do WhatsApp com o pedido do painel.

alter table public.acai_orders add column if not exists order_number integer;

create or replace function public.acai_set_order_number()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  -- serializa por loja: dois pedidos ao mesmo tempo nunca pegam o mesmo número
  perform pg_advisory_xact_lock(hashtext('acai_order_number:' || new.store_id::text));
  select coalesce(max(o.order_number), 0) + 1 into new.order_number
  from public.acai_orders o
  where o.store_id = new.store_id
    and (o.created_at at time zone 'America/Sao_Paulo')::date = (new.created_at at time zone 'America/Sao_Paulo')::date;
  return new;
end;
$$;

drop trigger if exists acai_orders_number on public.acai_orders;
create trigger acai_orders_number
  before insert on public.acai_orders
  for each row execute function public.acai_set_order_number();

revoke all on function public.acai_set_order_number() from public, anon, authenticated;

-- Acompanhamento devolve o número também.
drop function if exists public.get_acai_order_status(uuid);
create function public.get_acai_order_status(p_order_id uuid)
returns table (
  order_number integer,
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
  select o.order_number, o.status, o.fulfillment_type, o.items_subtotal, o.delivery_fee, o.total,
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

grant execute on function public.get_acai_order_status(uuid) to anon, authenticated;

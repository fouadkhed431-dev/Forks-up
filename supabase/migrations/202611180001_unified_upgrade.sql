-- Forks Up unified upgrade: settlement, payment tracking, employee directory and favorites.
begin;

alter table public.rounds
  add column if not exists settlement_status text not null default 'draft'
    check (settlement_status in ('draft','settled')),
  add column if not exists settled_at timestamptz;

alter table public.orders
  add column if not exists payment_status text not null default 'unpaid'
    check (payment_status in ('unpaid','partial','paid')),
  add column if not exists amount_paid numeric(12,2) not null default 0
    check (amount_paid >= 0);

create table if not exists public.employee_profiles (
  id uuid primary key default gen_random_uuid(),
  created_by uuid not null references auth.users(id) on delete cascade,
  employee_name text not null check (length(trim(employee_name)) between 2 and 100),
  phone text,
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.favorite_items (
  id uuid primary key default gen_random_uuid(),
  created_by uuid not null references auth.users(id) on delete cascade,
  item_name text not null check (length(trim(item_name)) between 1 and 180),
  restaurant_name text not null default '',
  created_at timestamptz not null default now()
);

create unique index if not exists employee_profiles_owner_name_uidx
  on public.employee_profiles(created_by, lower(trim(employee_name)));
create unique index if not exists favorite_items_owner_item_restaurant_uidx
  on public.favorite_items(created_by, lower(trim(item_name)), lower(trim(restaurant_name)));

alter table public.employee_profiles enable row level security;
alter table public.favorite_items enable row level security;

drop policy if exists "admin manages own employee profiles" on public.employee_profiles;
create policy "admin manages own employee profiles" on public.employee_profiles
  for all to authenticated using (created_by = auth.uid()) with check (created_by = auth.uid());

drop policy if exists "admin manages own favorite items" on public.favorite_items;
create policy "admin manages own favorite items" on public.favorite_items
  for all to authenticated using (created_by = auth.uid()) with check (created_by = auth.uid());

grant select, insert, update, delete on public.employee_profiles, public.favorite_items to authenticated;

-- Admin-created orders remain subject to the same validation as public submissions,
-- but are callable only by the owner of the round.
create or replace function public.admin_create_order(p_round_id uuid, p_employee_name text, p_items jsonb)
returns uuid language plpgsql security definer set search_path = public as $$
declare
  v_round public.rounds%rowtype;
  v_order_id uuid;
  v_item jsonb;
  v_name text := trim(coalesce(p_employee_name,''));
  v_kind text;
  v_qty integer;
  v_participants text[];
begin
  select * into v_round from public.rounds where id=p_round_id for update;
  if not found or v_round.created_by <> auth.uid() then raise exception 'NOT_ALLOWED'; end if;
  if v_round.status <> 'open' or (v_round.deadline is not null and v_round.deadline <= now()) then
    raise exception 'ROUND_CLOSED';
  end if;
  if length(v_name) < 2 or length(v_name) > 100 then raise exception 'INVALID_EMPLOYEE_NAME'; end if;
  if p_items is null or jsonb_typeof(p_items) is distinct from 'array'
     or jsonb_array_length(p_items) < 1 or jsonb_array_length(p_items) > 30 then
    raise exception 'INVALID_ITEMS';
  end if;
  if exists (select 1 from public.orders where round_id=p_round_id and lower(trim(employee_name))=lower(v_name)) then
    raise exception 'DUPLICATE_EMPLOYEE_ORDER';
  end if;
  insert into public.orders(round_id,employee_name) values(p_round_id,v_name) returning id into v_order_id;
  for v_item in select value from jsonb_array_elements(p_items) loop
    if length(trim(coalesce(v_item->>'description',''))) < 1 or length(trim(v_item->>'description')) > 180 then
      raise exception 'INVALID_ITEM_DESCRIPTION';
    end if;
    v_qty := greatest(1,least(99,coalesce((v_item->>'quantity')::integer,1)));
    v_kind := case when v_item->>'kind'='shared' then 'shared' else 'individual' end;
    select array_agg(distinct trim(x)) into v_participants
      from unnest(array[v_name] || coalesce(array(select jsonb_array_elements_text(coalesce(v_item->'participants','[]'::jsonb))),'{}')) x
      where length(trim(x)) between 2 and 100;
    if v_kind='individual' then v_participants := '{}';
    elsif coalesce(array_length(v_participants,1),0)<2 then raise exception 'SHARED_ITEM_NEEDS_PARTICIPANTS';
    elsif array_length(v_participants,1)>20 then raise exception 'TOO_MANY_PARTICIPANTS';
    end if;
    insert into public.order_items(order_id,description,quantity,kind,participants)
      values(v_order_id,trim(v_item->>'description'),v_qty,v_kind,coalesce(v_participants,'{}'));
  end loop;
  insert into public.edit_logs(round_id,order_id,actor_id,action,after_data)
    values(p_round_id,v_order_id,auth.uid(),'order_created',
      jsonb_build_object('employee_name',v_name,'items',p_items));
  insert into public.employee_profiles(created_by,employee_name)
    values(auth.uid(),v_name) on conflict do nothing;
  return v_order_id;
end;
$$;

-- Closing a round stops public submissions, but the administrator can still
-- correct orders and delete mistaken entries while preparing the invoice.
create or replace function public.admin_save_order(p_order_id uuid, p_employee_name text, p_items jsonb)
returns void language plpgsql security definer set search_path = public as $$
declare
  v_order public.orders%rowtype;
  v_round public.rounds%rowtype;
  v_before jsonb;
  v_name text := trim(coalesce(p_employee_name,''));
  v_item jsonb;
  v_kind text;
  v_qty integer;
  v_participants text[];
begin
  select * into v_order from public.orders where id=p_order_id for update;
  if not found then raise exception 'ORDER_NOT_FOUND'; end if;
  select * into v_round from public.rounds where id=v_order.round_id for update;
  if v_round.created_by <> auth.uid() then raise exception 'NOT_ALLOWED'; end if;
  if length(v_name)<2 or length(v_name)>100 then raise exception 'INVALID_EMPLOYEE_NAME'; end if;
  if p_items is null or jsonb_typeof(p_items) is distinct from 'array'
     or jsonb_array_length(p_items)<1 or jsonb_array_length(p_items)>30 then raise exception 'INVALID_ITEMS'; end if;
  select jsonb_build_object('employee_name',v_order.employee_name,
    'items',coalesce((select jsonb_agg(to_jsonb(i)) from public.order_items i where i.order_id=p_order_id),'[]'::jsonb))
    into v_before;
  update public.orders set employee_name=v_name where id=p_order_id;
  delete from public.order_items where order_id=p_order_id;
  for v_item in select value from jsonb_array_elements(p_items) loop
    if length(trim(coalesce(v_item->>'description','')))<1 or length(trim(v_item->>'description'))>180 then
      raise exception 'INVALID_ITEM_DESCRIPTION';
    end if;
    v_qty := greatest(1,least(99,coalesce((v_item->>'quantity')::integer,1)));
    v_kind := case when v_item->>'kind'='shared' then 'shared' else 'individual' end;
    select array_agg(distinct trim(x)) into v_participants
      from unnest(array[v_name] || coalesce(array(select jsonb_array_elements_text(coalesce(v_item->'participants','[]'::jsonb))),'{}')) x
      where length(trim(x)) between 2 and 100;
    if v_kind='individual' then v_participants := '{}';
    elsif coalesce(array_length(v_participants,1),0)<2 then raise exception 'SHARED_ITEM_NEEDS_PARTICIPANTS';
    elsif array_length(v_participants,1)>20 then raise exception 'TOO_MANY_PARTICIPANTS';
    end if;
    insert into public.order_items(order_id,description,quantity,kind,participants)
      values(p_order_id,trim(v_item->>'description'),v_qty,v_kind,coalesce(v_participants,'{}'));
  end loop;
  insert into public.edit_logs(round_id,order_id,actor_id,action,before_data,after_data)
    values(v_round.id,p_order_id,auth.uid(),'order_updated',v_before,
      jsonb_build_object('employee_name',v_name,'items',p_items));
end;
$$;

create or replace function public.admin_delete_order(p_order_id uuid)
returns void language plpgsql security definer set search_path = public as $$
declare
  v_order public.orders%rowtype;
  v_round public.rounds%rowtype;
  v_before jsonb;
begin
  select * into v_order from public.orders where id=p_order_id for update;
  if not found then raise exception 'ORDER_NOT_FOUND'; end if;
  select * into v_round from public.rounds where id=v_order.round_id for update;
  if v_round.created_by <> auth.uid() then raise exception 'NOT_ALLOWED'; end if;
  select jsonb_build_object('employee_name',v_order.employee_name,
    'items',coalesce((select jsonb_agg(to_jsonb(i)) from public.order_items i where i.order_id=p_order_id),'[]'::jsonb))
    into v_before;
  insert into public.edit_logs(round_id,order_id,actor_id,action,before_data)
    values(v_round.id,p_order_id,auth.uid(),'order_deleted',v_before);
  delete from public.orders where id=p_order_id;
end;
$$;

create or replace function public.admin_settle_round(p_round_id uuid)
returns void language plpgsql security definer set search_path = public as $$
begin
  update public.rounds set settlement_status='settled', settled_at=now()
  where id=p_round_id and created_by=auth.uid() and status='closed';
  if not found then raise exception 'ROUND_MUST_BE_CLOSED_AND_OWNED'; end if;
end;
$$;

revoke all on function public.admin_create_order(uuid,text,jsonb) from public;
revoke all on function public.admin_settle_round(uuid) from public;
grant execute on function public.admin_create_order(uuid,text,jsonb) to authenticated;
grant execute on function public.admin_settle_round(uuid) to authenticated;

commit;

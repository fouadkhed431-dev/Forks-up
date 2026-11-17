-- Forks Up: production schema, row-level security and safe public order RPCs.
create extension if not exists pgcrypto;

create table if not exists public.rounds (
  id uuid primary key default gen_random_uuid(),
  created_by uuid not null references auth.users(id) on delete cascade,
  public_token uuid not null unique default gen_random_uuid(),
  title text not null default '',
  food_type text not null,
  deadline timestamptz,
  status text not null default 'open' check (status in ('open','closed')),
  menu_path text,
  delivery_fee numeric(12,2) not null default 0 check (delivery_fee >= 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.orders (
  id uuid primary key default gen_random_uuid(),
  round_id uuid not null references public.rounds(id) on delete cascade,
  employee_name text not null check (length(trim(employee_name)) between 2 and 100),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.order_items (
  id uuid primary key default gen_random_uuid(),
  order_id uuid not null references public.orders(id) on delete cascade,
  description text not null check (length(trim(description)) between 1 and 180),
  quantity integer not null default 1 check (quantity between 1 and 99),
  kind text not null default 'individual' check (kind in ('individual','shared')),
  participants text[] not null default '{}'
);

create table if not exists public.item_prices (
  id uuid primary key default gen_random_uuid(),
  round_id uuid not null references public.rounds(id) on delete cascade,
  normalized_name text not null,
  display_name text not null,
  unit_price numeric(12,2) not null default 0 check (unit_price >= 0),
  unique(round_id, normalized_name)
);

create table if not exists public.edit_logs (
  id uuid primary key default gen_random_uuid(),
  round_id uuid not null references public.rounds(id) on delete cascade,
  order_id uuid references public.orders(id) on delete set null,
  actor_id uuid references auth.users(id) on delete set null,
  action text not null,
  before_data jsonb,
  after_data jsonb,
  created_at timestamptz not null default now()
);

create index if not exists rounds_created_by_created_at_idx on public.rounds(created_by, created_at desc);
create index if not exists orders_round_id_idx on public.orders(round_id, created_at);
-- One order per employee name per round; prevents accidental duplicate submissions.
create unique index if not exists orders_round_employee_unique
  on public.orders(round_id, lower(trim(employee_name)));
create index if not exists order_items_order_id_idx on public.order_items(order_id);
create index if not exists edit_logs_round_id_created_at_idx on public.edit_logs(round_id, created_at desc);

create or replace function public.touch_updated_at()
returns trigger language plpgsql as $$ begin new.updated_at = now(); return new; end; $$;
drop trigger if exists rounds_touch_updated_at on public.rounds;
create trigger rounds_touch_updated_at before update on public.rounds for each row execute function public.touch_updated_at();
drop trigger if exists orders_touch_updated_at on public.orders;
create trigger orders_touch_updated_at before update on public.orders for each row execute function public.touch_updated_at();

alter table public.rounds enable row level security;
alter table public.orders enable row level security;
alter table public.order_items enable row level security;
alter table public.item_prices enable row level security;
alter table public.edit_logs enable row level security;

-- Admin can see/manage only their own rounds. Public visitors can only resolve open rounds.
drop policy if exists "admin manages own rounds" on public.rounds;
create policy "admin manages own rounds" on public.rounds for all to authenticated
  using (created_by = auth.uid()) with check (created_by = auth.uid());
drop policy if exists "public can resolve open rounds" on public.rounds;
create policy "public can resolve open rounds" on public.rounds for select to anon
  using (status = 'open' and (deadline is null or deadline > now()));

drop policy if exists "admin reads own orders" on public.orders;
create policy "admin reads own orders" on public.orders for select to authenticated
  using (exists (select 1 from public.rounds r where r.id = round_id and r.created_by = auth.uid()));
drop policy if exists "admin updates own orders" on public.orders;
create policy "admin updates own orders" on public.orders for update to authenticated
  using (exists (select 1 from public.rounds r where r.id = round_id and r.created_by = auth.uid()))
  with check (exists (select 1 from public.rounds r where r.id = round_id and r.created_by = auth.uid()));
drop policy if exists "admin deletes own orders" on public.orders;
create policy "admin deletes own orders" on public.orders for delete to authenticated
  using (exists (select 1 from public.rounds r where r.id = round_id and r.created_by = auth.uid()));

drop policy if exists "admin reads own order items" on public.order_items;
create policy "admin reads own order items" on public.order_items for select to authenticated
  using (exists (select 1 from public.orders o join public.rounds r on r.id=o.round_id where o.id=order_id and r.created_by=auth.uid()));

drop policy if exists "admin manages own item prices" on public.item_prices;
create policy "admin manages own item prices" on public.item_prices for all to authenticated
  using (exists (select 1 from public.rounds r where r.id=round_id and r.created_by=auth.uid()))
  with check (exists (select 1 from public.rounds r where r.id=round_id and r.created_by=auth.uid()));

drop policy if exists "admin reads own edit logs" on public.edit_logs;
create policy "admin reads own edit logs" on public.edit_logs for select to authenticated
  using (exists (select 1 from public.rounds r where r.id=round_id and r.created_by=auth.uid()));

-- Explicit API grants; anonymous users interact only through the two public RPCs.
grant usage on schema public to anon, authenticated;
grant select, insert, update, delete on public.rounds, public.orders, public.order_items, public.item_prices, public.edit_logs to authenticated;

-- A public employee can resolve a round by its unguessable token, but cannot read other people's orders.
create or replace function public.get_public_round(p_token uuid)
returns jsonb language sql stable security definer set search_path = public as $$
  select jsonb_build_object('id', r.id, 'token', r.public_token, 'title', r.title,
    'food_type', r.food_type, 'deadline', r.deadline, 'status', r.status, 'menu_path', r.menu_path)
  from public.rounds r
  where r.public_token = p_token and r.status = 'open' and (r.deadline is null or r.deadline > now())
  limit 1;
$$;

create or replace function public.submit_public_order(p_token uuid, p_employee_name text, p_items jsonb)
returns uuid language plpgsql security definer set search_path = public as $$
declare
  v_round public.rounds%rowtype;
  v_order_id uuid;
  v_item jsonb;
  v_name text;
  v_kind text;
  v_qty integer;
  v_participants text[];
begin
  select * into v_round from public.rounds
  where public_token = p_token and status = 'open' and (deadline is null or deadline > now())
  for update;
  if not found then raise exception 'ROUND_CLOSED_OR_NOT_FOUND'; end if;
  v_name := trim(coalesce(p_employee_name, ''));
  if length(v_name) < 2 or length(v_name) > 100 then raise exception 'INVALID_EMPLOYEE_NAME'; end if;
  if p_items is null or jsonb_typeof(p_items) is distinct from 'array' then raise exception 'INVALID_ITEMS'; end if;
  if jsonb_array_length(p_items) < 1 or jsonb_array_length(p_items) > 30 then raise exception 'INVALID_ITEMS'; end if;
  if exists (
    select 1 from public.orders
    where round_id = v_round.id and lower(trim(employee_name)) = lower(v_name)
  ) then
    raise exception 'DUPLICATE_EMPLOYEE_ORDER';
  end if;
  insert into public.orders(round_id, employee_name) values (v_round.id, v_name) returning id into v_order_id;
  for v_item in select value from jsonb_array_elements(p_items) loop
    if length(trim(coalesce(v_item->>'description',''))) < 1 or length(trim(v_item->>'description')) > 180 then raise exception 'INVALID_ITEM_DESCRIPTION'; end if;
    v_qty := greatest(1, least(99, coalesce((v_item->>'quantity')::integer, 1)));
    v_kind := case when v_item->>'kind' = 'shared' then 'shared' else 'individual' end;
    select array_agg(distinct trim(x)) into v_participants
      from unnest(array[v_name] || coalesce(array(select jsonb_array_elements_text(coalesce(v_item->'participants','[]'::jsonb))), '{}')) x
      where length(trim(x)) between 2 and 100;
    if v_kind = 'individual' then v_participants := '{}';
    elsif coalesce(array_length(v_participants, 1), 0) < 2 then
      raise exception 'SHARED_ITEM_NEEDS_PARTICIPANTS';
    elsif array_length(v_participants, 1) > 20 then
      raise exception 'TOO_MANY_PARTICIPANTS';
    end if;
    insert into public.order_items(order_id, description, quantity, kind, participants)
    values (v_order_id, trim(v_item->>'description'), v_qty, v_kind, coalesce(v_participants, '{}'));
  end loop;
  return v_order_id;
end;
$$;

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
  if v_round.status <> 'open' or (v_round.deadline is not null and v_round.deadline <= now()) then raise exception 'ROUND_CLOSED'; end if;
  if length(v_name) < 2 or length(v_name) > 100 then raise exception 'INVALID_EMPLOYEE_NAME'; end if;
  if p_items is null or jsonb_typeof(p_items) is distinct from 'array' then raise exception 'INVALID_ITEMS'; end if;
  if jsonb_array_length(p_items) < 1 or jsonb_array_length(p_items) > 30 then raise exception 'INVALID_ITEMS'; end if;
  select jsonb_build_object('employee_name',v_order.employee_name,'items',coalesce(jsonb_agg(to_jsonb(i)),'[]'::jsonb))
    into v_before from public.order_items i where i.order_id=p_order_id;
  update public.orders set employee_name=v_name where id=p_order_id;
  delete from public.order_items where order_id=p_order_id;
  for v_item in select value from jsonb_array_elements(p_items) loop
    if length(trim(coalesce(v_item->>'description',''))) < 1 or length(trim(v_item->>'description')) > 180 then raise exception 'INVALID_ITEM_DESCRIPTION'; end if;
    v_qty := greatest(1, least(99, coalesce((v_item->>'quantity')::integer,1)));
    v_kind := case when v_item->>'kind'='shared' then 'shared' else 'individual' end;
    select array_agg(distinct trim(x)) into v_participants
      from unnest(array[v_name] || coalesce(array(select jsonb_array_elements_text(coalesce(v_item->'participants','[]'::jsonb))), '{}')) x
      where length(trim(x)) between 2 and 100;
    if v_kind='individual' then v_participants := '{}';
    elsif coalesce(array_length(v_participants, 1), 0) < 2 then
      raise exception 'SHARED_ITEM_NEEDS_PARTICIPANTS';
    elsif array_length(v_participants, 1) > 20 then
      raise exception 'TOO_MANY_PARTICIPANTS';
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
  if v_round.status <> 'open' or (v_round.deadline is not null and v_round.deadline <= now()) then raise exception 'ROUND_CLOSED'; end if;
  select jsonb_build_object('employee_name',v_order.employee_name,'items',coalesce(jsonb_agg(to_jsonb(i)),'[]'::jsonb))
    into v_before from public.order_items i where i.order_id=p_order_id;
  insert into public.edit_logs(round_id,order_id,actor_id,action,before_data)
  values(v_round.id,p_order_id,auth.uid(),'order_deleted',v_before);
  delete from public.orders where id=p_order_id;
end;
$$;

revoke all on function public.get_public_round(uuid) from public;
revoke all on function public.submit_public_order(uuid,text,jsonb) from public;
revoke all on function public.admin_save_order(uuid,text,jsonb) from public;
revoke all on function public.admin_delete_order(uuid) from public;
grant execute on function public.get_public_round(uuid) to anon, authenticated;
grant execute on function public.submit_public_order(uuid,text,jsonb) to anon, authenticated;
grant execute on function public.admin_save_order(uuid,text,jsonb) to authenticated;
grant execute on function public.admin_delete_order(uuid) to authenticated;

-- Enable database change events for the admin dashboard when the publication exists.
do $$ begin
  if exists (select 1 from pg_publication where pubname='supabase_realtime') then
    if not exists (select 1 from pg_publication_tables where pubname='supabase_realtime' and schemaname='public' and tablename='orders') then alter publication supabase_realtime add table public.orders; end if;
    if not exists (select 1 from pg_publication_tables where pubname='supabase_realtime' and schemaname='public' and tablename='rounds') then alter publication supabase_realtime add table public.rounds; end if;
    if not exists (select 1 from pg_publication_tables where pubname='supabase_realtime' and schemaname='public' and tablename='item_prices') then alter publication supabase_realtime add table public.item_prices; end if;
  end if;
end $$;

-- Public menu reads; only authenticated users may upload to their own user-id folder.
insert into storage.buckets(id,name,public,file_size_limit,allowed_mime_types)
values ('round-menus','round-menus',true,10485760,array['image/jpeg','image/png','image/webp','application/pdf'])
on conflict (id) do update set public=true, file_size_limit=10485760, allowed_mime_types=array['image/jpeg','image/png','image/webp','application/pdf'];
drop policy if exists "admin uploads own round menus" on storage.objects;
create policy "admin uploads own round menus" on storage.objects for insert to authenticated
  with check (bucket_id='round-menus' and (storage.foldername(name))[1]=auth.uid()::text);
drop policy if exists "admin updates own round menus" on storage.objects;
create policy "admin updates own round menus" on storage.objects for update to authenticated
  using (bucket_id='round-menus' and (storage.foldername(name))[1]=auth.uid()::text)
  with check (bucket_id='round-menus' and (storage.foldername(name))[1]=auth.uid()::text);
drop policy if exists "admin deletes own round menus" on storage.objects;
create policy "admin deletes own round menus" on storage.objects for delete to authenticated
  using (bucket_id='round-menus' and (storage.foldername(name))[1]=auth.uid()::text);

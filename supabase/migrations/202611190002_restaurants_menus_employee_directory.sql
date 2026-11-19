-- Restaurant menus and stable employee identities for Forks Up.
begin;

create table if not exists public.restaurants (
  id uuid primary key default gen_random_uuid(),
  created_by uuid not null references auth.users(id) on delete cascade,
  name text not null check (length(trim(name)) between 2 and 120),
  category text not null default '',
  created_at timestamptz not null default now()
);
create unique index if not exists restaurants_owner_name_uidx on public.restaurants(created_by, lower(trim(name)));

create table if not exists public.restaurant_menu_items (
  id uuid primary key default gen_random_uuid(),
  restaurant_id uuid not null references public.restaurants(id) on delete cascade,
  name text not null check (length(trim(name)) between 1 and 180),
  normalized_name text not null,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  unique (restaurant_id, normalized_name)
);

create table if not exists public.employee_directory (
  id uuid primary key default gen_random_uuid(),
  created_by uuid not null references auth.users(id) on delete cascade,
  employee_name text not null check (length(trim(employee_name)) between 2 and 100),
  normalized_name text not null,
  created_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  unique (created_by, normalized_name)
);

alter table public.rounds add column if not exists restaurant_id uuid references public.restaurants(id) on delete set null;
alter table public.order_items add column if not exists menu_item_id uuid references public.restaurant_menu_items(id) on delete set null;
alter table public.orders add column if not exists employee_id uuid references public.employee_directory(id) on delete set null;
alter table public.order_items add column if not exists participant_ids uuid[] not null default '{}';

alter table public.restaurants enable row level security;
alter table public.restaurant_menu_items enable row level security;
alter table public.employee_directory enable row level security;

drop policy if exists "admin manages own restaurants" on public.restaurants;
create policy "admin manages own restaurants" on public.restaurants for all to authenticated
using (created_by=auth.uid()) with check (created_by=auth.uid());

drop policy if exists "admin manages own restaurant menu" on public.restaurant_menu_items;
create policy "admin manages own restaurant menu" on public.restaurant_menu_items for all to authenticated
using (exists(select 1 from public.restaurants r where r.id=restaurant_id and r.created_by=auth.uid()))
with check (exists(select 1 from public.restaurants r where r.id=restaurant_id and r.created_by=auth.uid()));

drop policy if exists "admin manages own employee directory" on public.employee_directory;
create policy "admin manages own employee directory" on public.employee_directory for all to authenticated
using (created_by=auth.uid()) with check (created_by=auth.uid());

grant select, insert, update, delete on public.restaurants, public.restaurant_menu_items, public.employee_directory to authenticated;

-- Seed the employee directory from all historical orders without changing any legacy order.
insert into public.employee_directory(created_by, employee_name, normalized_name, last_seen_at)
select r.created_by, min(trim(o.employee_name)),
       lower(regexp_replace(trim(o.employee_name), '\\s+', ' ', 'g')), max(o.created_at)
from public.orders o join public.rounds r on r.id=o.round_id
where length(trim(o.employee_name)) between 2 and 100
group by r.created_by, lower(regexp_replace(trim(o.employee_name), '\\s+', ' ', 'g'))
on conflict (created_by, normalized_name) do update
set last_seen_at=greatest(public.employee_directory.last_seen_at, excluded.last_seen_at);

-- Backfill stable owner IDs and participant IDs while retaining legacy name arrays for invoices.
update public.orders o set employee_id=e.id
from public.rounds r, public.employee_directory e
where r.id=o.round_id and e.created_by=r.created_by
  and e.normalized_name=lower(regexp_replace(trim(o.employee_name), '\\s+', ' ', 'g'))
  and o.employee_id is null;

update public.order_items oi set participant_ids = coalesce((
  select array_agg(distinct e.id)
  from public.orders o
  join public.rounds r on r.id=o.round_id
  cross join lateral unnest(oi.participants) p(name)
  join public.employee_directory e on e.created_by=r.created_by
    and e.normalized_name=lower(regexp_replace(trim(p.name), '\\s+', ' ', 'g'))
  where o.id=oi.order_id
), '{}'::uuid[])
where oi.kind='shared' and cardinality(oi.participant_ids)=0;

-- Keep stable IDs synchronized for both public submissions and administrator edits.
create or replace function public.sync_forksup_employee_ids()
returns trigger language plpgsql security definer set search_path=public as $$
declare
  v_owner uuid;
  v_created_by uuid;
  v_name text;
begin
  if tg_table_name='orders' then
    select created_by into v_created_by from public.rounds where id=new.round_id;
    insert into public.employee_directory(created_by,employee_name,normalized_name,last_seen_at)
    values(v_created_by,trim(new.employee_name),lower(regexp_replace(trim(new.employee_name),'\\s+',' ','g')),now())
    on conflict(created_by,normalized_name) do update set
      employee_name=excluded.employee_name,last_seen_at=now()
    returning id into new.employee_id;
    return new;
  end if;

  select o.employee_id,r.created_by into v_owner,v_created_by
  from public.orders o join public.rounds r on r.id=o.round_id where o.id=new.order_id;

  new.participant_ids := '{}';
  if new.kind='shared' then
    foreach v_name in array coalesce(new.participants,'{}') loop
      if length(trim(v_name)) between 2 and 100 then
        insert into public.employee_directory(created_by,employee_name,normalized_name,last_seen_at)
        values(v_created_by,trim(v_name),lower(regexp_replace(trim(v_name),'\\s+',' ','g')),now())
        on conflict(created_by,normalized_name) do update set last_seen_at=now()
        returning id into v_owner;
        new.participant_ids := array_append(new.participant_ids,v_owner);
      end if;
    end loop;
    select coalesce(array_agg(distinct x),'{}'::uuid[]) into new.participant_ids
    from unnest(new.participant_ids) x;
  end if;
  return new;
end;
$$;

drop trigger if exists forksup_orders_employee_ids on public.orders;
create trigger forksup_orders_employee_ids before insert or update of employee_name,round_id on public.orders
for each row execute function public.sync_forksup_employee_ids();

drop trigger if exists forksup_items_participant_ids on public.order_items;
create trigger forksup_items_participant_ids before insert or update of participants,kind,order_id on public.order_items
for each row execute function public.sync_forksup_employee_ids();

-- Register the first known restaurant. Menus can be populated later from the actual restaurant menu.
insert into public.restaurants(created_by,name,category)
select distinct created_by,'أسماك الحوت','مأكولات بحرية'
from public.rounds
where created_by is not null
on conflict (created_by, (lower(trim(name)))) do nothing;

commit;

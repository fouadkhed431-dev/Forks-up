begin;

create table if not exists public.restaurant_menus (
  id uuid primary key default gen_random_uuid(),
  restaurant_id uuid not null references public.restaurants(id) on delete cascade,
  name text not null check (length(trim(name)) between 2 and 120),
  created_at timestamptz not null default now(),
  unique (restaurant_id, name)
);

create table if not exists public.restaurant_menu_categories (
  id uuid primary key default gen_random_uuid(),
  menu_id uuid not null references public.restaurant_menus(id) on delete cascade,
  name text not null check (length(trim(name)) between 2 and 80),
  sort_order integer not null default 0,
  created_at timestamptz not null default now(),
  unique (menu_id, name)
);

alter table public.rounds add column if not exists menu_id uuid references public.restaurant_menus(id) on delete set null;
alter table public.restaurant_menu_items add column if not exists menu_id uuid references public.restaurant_menus(id) on delete cascade;
alter table public.restaurant_menu_items add column if not exists weight_options text[] not null default '{}';

-- Every existing restaurant gets a default menu; its current items and rounds remain attached.
insert into public.restaurant_menus(restaurant_id,name)
select r.id, 'المنيو الرئيسي'
from public.restaurants r
where not exists(select 1 from public.restaurant_menus m where m.restaurant_id=r.id);

update public.restaurant_menu_items mi
set menu_id = (select m.id from public.restaurant_menus m where m.restaurant_id=mi.restaurant_id order by m.created_at limit 1)
where mi.menu_id is null;

update public.rounds rd
set menu_id = (select m.id from public.restaurant_menus m where m.restaurant_id=rd.restaurant_id order by m.created_at limit 1)
where rd.menu_id is null and rd.restaurant_id is not null;

-- Allow the same dish in more than one named menu.
alter table public.restaurant_menu_items
  drop constraint if exists restaurant_menu_items_restaurant_id_normalized_name_key;
create unique index if not exists restaurant_menu_items_menu_normalized_uidx
  on public.restaurant_menu_items(menu_id, normalized_name)
  where menu_id is not null;

insert into public.restaurant_menu_categories(menu_id,name,sort_order)
select m.id, c.name, c.ord
from public.restaurant_menus m
cross join (values
  ('السلطات',1),('الأرز والأطباق الجانبية',2),('السمك',3),('الجمبري',4),
  ('الطواجن',5),('الوجبات',6),('الشوربات',7),('السندوتشات',8),('أصناف أخرى',9)
) as c(name,ord)
on conflict(menu_id,name) do nothing;

alter table public.restaurant_menus enable row level security;
alter table public.restaurant_menu_categories enable row level security;

drop policy if exists "admin manages own restaurant menus" on public.restaurant_menus;
create policy "admin manages own restaurant menus" on public.restaurant_menus
for all to authenticated
using (exists(select 1 from public.restaurants r where r.id=restaurant_id and r.created_by=auth.uid()))
with check (exists(select 1 from public.restaurants r where r.id=restaurant_id and r.created_by=auth.uid()));

drop policy if exists "admin manages own menu categories" on public.restaurant_menu_categories;
create policy "admin manages own menu categories" on public.restaurant_menu_categories
for all to authenticated
using (exists(select 1 from public.restaurant_menus m join public.restaurants r on r.id=m.restaurant_id where m.id=menu_id and r.created_by=auth.uid()))
with check (exists(select 1 from public.restaurant_menus m join public.restaurants r on r.id=m.restaurant_id where m.id=menu_id and r.created_by=auth.uid()));

drop policy if exists "admin manages own restaurant menu" on public.restaurant_menu_items;
create policy "admin manages own restaurant menu" on public.restaurant_menu_items for all to authenticated
using (exists(select 1 from public.restaurants r where r.id=restaurant_id and r.created_by=auth.uid()))
with check (exists(select 1 from public.restaurants r where r.id=restaurant_id and r.created_by=auth.uid()));

grant select, insert, update, delete on public.restaurant_menus, public.restaurant_menu_categories to authenticated;

create or replace function public.get_public_round(p_token uuid)
returns jsonb language sql stable security definer set search_path=public as $get_public_round$
  select jsonb_build_object(
    'id',r.id,'token',r.public_token,'title',r.title,'food_type',r.food_type,
    'deadline',r.deadline,'status',r.status,'menu_path',r.menu_path,
    'restaurant_id',r.restaurant_id,'menu_id',r.menu_id,
    'restaurant_name',coalesce(rest.name,''),'menu_name',coalesce(m.name,''),
    'menu_categories',coalesce((
      select jsonb_agg(jsonb_build_object('id',c.id,'name',c.name,'sort_order',c.sort_order) order by c.sort_order,c.name)
      from public.restaurant_menu_categories c where c.menu_id=r.menu_id
    ),'[]'::jsonb),
    'menu_items',coalesce((
      select jsonb_agg(jsonb_build_object('id',mi.id,'name',mi.name,'category',mi.category,'subcategory',mi.subcategory,'preparation',mi.preparation,'weight_options',mi.weight_options) order by mi.category,mi.sort_order,mi.name)
      from public.restaurant_menu_items mi
      where mi.menu_id=r.menu_id and mi.active=true
    ),'[]'::jsonb),
    'employee_names',coalesce((
      select jsonb_agg(ed.employee_name order by ed.employee_name)
      from public.employee_directory ed where ed.created_by=r.created_by
    ),'[]'::jsonb)
  )
  from public.rounds r
  left join public.restaurants rest on rest.id=r.restaurant_id
  left join public.restaurant_menus m on m.id=r.menu_id
  where r.public_token=p_token and r.status='open' and (r.deadline is null or r.deadline>now())
  limit 1;
$get_public_round$;

create or replace function public.sync_forksup_round_menu_items()
returns trigger language plpgsql security definer set search_path=public as $sync_round$
begin
  if new.menu_id is distinct from old.menu_id and new.menu_id is not null then
    update public.order_items oi set menu_item_id=mi.id
    from public.orders o
    join public.restaurant_menu_items mi on mi.menu_id=new.menu_id
    where oi.order_id=o.id and o.round_id=new.id
      and lower(trim(oi.description))=lower(trim(mi.name));
  end if;
  return new;
end;
$sync_round$;

drop trigger if exists forksup_sync_round_menu_items on public.rounds;
create trigger forksup_sync_round_menu_items
after update of menu_id on public.rounds
for each row execute function public.sync_forksup_round_menu_items();

commit;

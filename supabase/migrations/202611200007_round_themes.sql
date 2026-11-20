-- Per-round visual identity for the public employee ordering page.
begin;

alter table public.rounds
  add column if not exists theme_key text not null default 'auto';

alter table public.rounds
  drop constraint if exists rounds_theme_key_check;

alter table public.rounds
  add constraint rounds_theme_key_check
  check (theme_key in ('auto','seafood','bistro','pizza','grill','general'));

create or replace function public.get_public_round(p_token uuid)
returns jsonb
language sql
stable
security definer
set search_path=public
as $get_public_round$
  select jsonb_build_object(
    'id',r.id,
    'token',r.public_token,
    'title',r.title,
    'food_type',r.food_type,
    'deadline',r.deadline,
    'status',r.status,
    'theme_key',coalesce(r.theme_key,'auto'),
    'menu_path',r.menu_path,
    'menu_paths',coalesce(r.menu_paths, case when r.menu_path is not null then array[r.menu_path] else '{}'::text[] end),
    'restaurant_id',r.restaurant_id,
    'restaurant_name',coalesce(rest.name,''),
    'menu_id',r.menu_id,
    'menu_name',coalesce(m.name,''),
    'menu_categories',coalesce((
      select jsonb_agg(jsonb_build_object(
        'id',c.id,'name',c.name,'sort_order',c.sort_order
      ) order by c.sort_order,c.name)
      from public.restaurant_menu_categories c
      where c.menu_id=r.menu_id
    ),'[]'::jsonb),
    'menu_items',coalesce((
      select jsonb_agg(jsonb_build_object(
        'id',mi.id,
        'name',mi.name,
        'category',mi.category,
        'subcategory',mi.subcategory,
        'preparation',mi.preparation,
        'weight_options',mi.weight_options,
        'default_price',mi.default_price,
        'single_price',mi.single_price,
        'double_price',mi.double_price
      ) order by mi.category,mi.sort_order,mi.name)
      from public.restaurant_menu_items mi
      where mi.menu_id=r.menu_id and mi.active=true
    ),'[]'::jsonb),
    'employee_names',coalesce((
      select jsonb_agg(ed.employee_name order by
        lower(coalesce(ed.category,'')),
        ed.sort_order,
        ed.employee_name
      )
      from public.employee_directory ed
      where ed.created_by=r.created_by
    ),'[]'::jsonb)
  )
  from public.rounds r
  left join public.restaurants rest on rest.id=r.restaurant_id
  left join public.restaurant_menus m on m.id=r.menu_id
  where r.public_token=p_token
    and r.status='open'
    and (r.deadline is null or r.deadline>now())
  limit 1;
$get_public_round$;

grant execute on function public.get_public_round(uuid) to anon,authenticated;

commit;

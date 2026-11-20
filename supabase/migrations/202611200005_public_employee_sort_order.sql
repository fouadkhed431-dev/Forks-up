-- Keep the employee picker in the order configured by the administrator.
-- Previously the public RPC explicitly sorted names alphabetically, ignoring sort_order.
begin;

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
    'menu_path',r.menu_path,
    'restaurant_id',r.restaurant_id,
    'restaurant_name',coalesce(rest.name,''),
    'menu_items',coalesce((
      select jsonb_agg(jsonb_build_object('id',mi.id,'name',mi.name) order by mi.name)
      from public.restaurant_menu_items mi
      where mi.restaurant_id=r.restaurant_id and mi.active=true
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
  where r.public_token=p_token
    and r.status='open'
    and (r.deadline is null or r.deadline>now())
  limit 1;
$get_public_round$;

grant execute on function public.get_public_round(uuid) to anon,authenticated;

commit;

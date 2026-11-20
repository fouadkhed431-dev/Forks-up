-- Admin employee directory management: grouping, ordering, and safe renaming.
begin;

alter table public.employee_directory
  add column if not exists category text not null default '',
  add column if not exists sort_order integer not null default 0;

create index if not exists employee_directory_owner_category_order_idx
  on public.employee_directory(created_by, category, sort_order, employee_name);

create or replace function public.admin_update_employee(
  p_employee_id uuid,
  p_employee_name text,
  p_category text default '',
  p_sort_order integer default 0
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_old_name text;
  v_old_normalized text;
  v_new_name text := trim(coalesce(p_employee_name, ''));
  v_new_normalized text;
  v_owner uuid := auth.uid();
begin
  if v_owner is null then
    raise exception 'AUTH_REQUIRED';
  end if;
  if length(v_new_name) < 2 or length(v_new_name) > 100 then
    raise exception 'INVALID_EMPLOYEE_NAME';
  end if;
  if length(trim(coalesce(p_category, ''))) > 60 then
    raise exception 'INVALID_EMPLOYEE_CATEGORY';
  end if;

  v_new_normalized := lower(regexp_replace(v_new_name, '[[:space:]]+', ' ', 'g'));

  select employee_name, normalized_name
    into v_old_name, v_old_normalized
  from public.employee_directory
  where id = p_employee_id and created_by = v_owner
  for update;

  if not found then
    raise exception 'EMPLOYEE_NOT_FOUND';
  end if;

  if exists (
    select 1 from public.employee_directory
    where created_by = v_owner
      and id <> p_employee_id
      and normalized_name = v_new_normalized
  ) then
    raise exception 'EMPLOYEE_NAME_EXISTS';
  end if;

  update public.employee_directory
  set employee_name = v_new_name,
      normalized_name = v_new_normalized,
      category = trim(coalesce(p_category, '')),
      sort_order = greatest(0, coalesce(p_sort_order, 0))
  where id = p_employee_id and created_by = v_owner;

  -- The existing triggers keep the stable employee ID linked while updating
  -- the visible name in every historical order and shared-item participant list.
  update public.orders
  set employee_name = v_new_name
  where employee_id = p_employee_id
    and round_id in (select id from public.rounds where created_by = v_owner);

  update public.order_items oi
  set participants = array_replace(oi.participants, v_old_name, v_new_name)
  where oi.kind = 'shared'
    and oi.participant_ids @> array[p_employee_id]::uuid[]
    and v_old_name = any(oi.participants)
    and oi.order_id in (
      select o.id
      from public.orders o
      join public.rounds r on r.id = o.round_id
      where r.created_by = v_owner
    );
end;
$$;

revoke all on function public.admin_update_employee(uuid, text, text, integer) from public;
grant execute on function public.admin_update_employee(uuid, text, text, integer) to authenticated;

commit;

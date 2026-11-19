begin;

-- Allow the authenticated round owner to add a correction order after closure.
-- Public submissions remain blocked by the existing guest submission function.
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
  return v_order_id;
end;
$$;

commit;

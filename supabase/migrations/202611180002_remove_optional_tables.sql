begin;

-- Recreate administrator RPCs without optional employee, favorite, or payment tables.
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
  return v_order_id;
end;
$$;


create or replace function public.admin_restore_backup(p_backup jsonb)
returns void language plpgsql security definer set search_path = public as $restore$
declare
  v jsonb;
  v_round_id uuid;
  v_order_id uuid;
begin
  if auth.uid() is null then raise exception 'NOT_ALLOWED'; end if;
  if p_backup is null or jsonb_typeof(p_backup) <> 'object' then raise exception 'INVALID_BACKUP'; end if;

  for v in select value from jsonb_array_elements(coalesce(p_backup->'rounds','[]'::jsonb)) loop
    insert into public.rounds(id,created_by,public_token,title,food_type,deadline,status,menu_path,delivery_fee,settlement_status,settled_at,created_at,updated_at)
    values((v->>'id')::uuid,auth.uid(),coalesce((v->>'public_token')::uuid,gen_random_uuid()),
      coalesce(v->>'title',''),coalesce(v->>'food_type','Imported round'),
      nullif(v->>'deadline','')::timestamptz,coalesce(v->>'status','closed'),v->>'menu_path',
      coalesce((v->>'delivery_fee')::numeric,0),coalesce(v->>'settlement_status','draft'),
      nullif(v->>'settled_at','')::timestamptz,coalesce(nullif(v->>'created_at','')::timestamptz,now()),
      coalesce(nullif(v->>'updated_at','')::timestamptz,now()))
    on conflict(id) do update set title=excluded.title,food_type=excluded.food_type,deadline=excluded.deadline,
      status=excluded.status,menu_path=excluded.menu_path,delivery_fee=excluded.delivery_fee,
      settlement_status=excluded.settlement_status,settled_at=excluded.settled_at
    where public.rounds.created_by=auth.uid();
  end loop;

  for v in select value from jsonb_array_elements(coalesce(p_backup->'orders','[]'::jsonb)) loop
    v_round_id := (v->>'round_id')::uuid;
    if not exists(select 1 from public.rounds where id=v_round_id and created_by=auth.uid()) then continue; end if;
    insert into public.orders(id,round_id,employee_name,created_at,updated_at,payment_status,amount_paid)
    values((v->>'id')::uuid,v_round_id,v->>'employee_name',
      coalesce(nullif(v->>'created_at','')::timestamptz,now()),
      coalesce(nullif(v->>'updated_at','')::timestamptz,now()),
      coalesce(v->>'payment_status','unpaid'),coalesce((v->>'amount_paid')::numeric,0))
    on conflict(id) do update set employee_name=excluded.employee_name,payment_status=excluded.payment_status,amount_paid=excluded.amount_paid
    where exists(select 1 from public.rounds r where r.id=public.orders.round_id and r.created_by=auth.uid());
  end loop;

  for v in select value from jsonb_array_elements(coalesce(p_backup->'order_items','[]'::jsonb)) loop
    v_order_id := (v->>'order_id')::uuid;
    if not exists(select 1 from public.orders o join public.rounds r on r.id=o.round_id where o.id=v_order_id and r.created_by=auth.uid()) then continue; end if;
    insert into public.order_items(id,order_id,description,quantity,kind,participants)
    values((v->>'id')::uuid,v_order_id,v->>'description',coalesce((v->>'quantity')::integer,1),
      coalesce(v->>'kind','individual'),coalesce(array(select jsonb_array_elements_text(coalesce(v->'participants','[]'::jsonb))),'{}'))
    on conflict(id) do update set description=excluded.description,quantity=excluded.quantity,kind=excluded.kind,participants=excluded.participants;
  end loop;

  for v in select value from jsonb_array_elements(coalesce(p_backup->'item_prices','[]'::jsonb)) loop
    v_round_id := (v->>'round_id')::uuid;
    if not exists(select 1 from public.rounds where id=v_round_id and created_by=auth.uid()) then continue; end if;
    insert into public.item_prices(id,round_id,normalized_name,display_name,unit_price)
    values((v->>'id')::uuid,v_round_id,v->>'normalized_name',v->>'display_name',coalesce((v->>'unit_price')::numeric,0))
    on conflict(round_id,normalized_name) do update set display_name=excluded.display_name,unit_price=excluded.unit_price;
  end loop;

  for v in select value from jsonb_array_elements(coalesce(p_backup->'edit_logs','[]'::jsonb)) loop
    v_round_id := (v->>'round_id')::uuid;
    if not exists(select 1 from public.rounds where id=v_round_id and created_by=auth.uid()) then continue; end if;
    insert into public.edit_logs(id,round_id,order_id,actor_id,action,before_data,after_data,created_at)
    values((v->>'id')::uuid,v_round_id,nullif(v->>'order_id','')::uuid,auth.uid(),coalesce(v->>'action','backup_restore'),
      v->'before_data',v->'after_data',coalesce(nullif(v->>'created_at','')::timestamptz,now()))
    on conflict(id) do nothing;
  end loop;

end;
$restore$;



drop function if exists public.admin_settle_round(uuid);

drop table if exists public.employee_profiles;
drop table if exists public.favorite_items;
drop table if exists public.round_payments;

commit;

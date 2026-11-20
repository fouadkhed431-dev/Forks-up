begin;

alter table public.restaurant_menu_items
  add column if not exists category text not null default 'أصناف أخرى',
  add column if not exists subcategory text not null default '',
  add column if not exists preparation text not null default '',
  add column if not exists sort_order integer not null default 0,
  add column if not exists updated_at timestamptz not null default now();

update public.restaurant_menu_items
set category = case
  when name ilike '%سلطة%' then 'السلطات'
  when name ilike '%أرز%' or name ilike '%رز%' or name ilike '%مكرونة%' then 'الأرز والأطباق الجانبية'
  when name ilike '%جمبري%' then 'الجمبري'
  when name ilike '%سمك%' or name ilike '%بوري%' or name ilike '%بلطي%' or name ilike '%دنيس%' or name ilike '%قاروص%' or name ilike '%ماكريل%' then 'السمك'
  when name ilike '%طاجن%' then 'الطواجن'
  when name ilike '%شوربة%' then 'الشوربات'
  when name ilike '%ساندوتش%' or name ilike '%رغيف%' then 'السندوتشات'
  when name ilike '%وجبة%' then 'الوجبات'
  else coalesce(nullif(category,''),'أصناف أخرى')
end
where category='أصناف أخرى';

create index if not exists restaurant_menu_items_order_idx
  on public.restaurant_menu_items(restaurant_id, active, sort_order, category, subcategory, name);

commit;

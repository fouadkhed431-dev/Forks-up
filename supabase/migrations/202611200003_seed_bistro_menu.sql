begin;

alter table public.restaurant_menu_items
  add column if not exists default_price numeric(10,2),
  add column if not exists single_price numeric(10,2),
  add column if not exists double_price numeric(10,2);

-- Add a separate Bistro restaurant for every existing restaurant owner.
insert into public.restaurants(created_by,name,category)
select distinct r.created_by,'Bistro','مطعم وجبات وسندوتشات'
from public.restaurants r
where not exists (
  select 1 from public.restaurants b
  where b.created_by=r.created_by and lower(trim(b.name))='bistro'
);

insert into public.restaurant_menus(restaurant_id,name)
select r.id,'Bistro'
from public.restaurants r
where lower(trim(r.name))='bistro'
on conflict(restaurant_id,name) do nothing;

insert into public.restaurant_menu_categories(menu_id,name,sort_order)
select m.id,c.name,c.sort_order
from public.restaurant_menus m
join public.restaurants r on r.id=m.restaurant_id
cross join (values
 ('برجر لحم',1),('برجر دجاج',2),('سندوتشات الردة',3),('حواوشي',4),('وجبات',5),('بيتزا',6)
) c(name,sort_order)
where lower(trim(r.name))='bistro' and m.name='Bistro'
on conflict(menu_id,name) do update set sort_order=excluded.sort_order;

with seed(category,name,price,single_price,double_price,weight_options,sort_order) as (values
-- Beef burgers: catalog prices are explicitly separated into Single and Double.
('برجر لحم','Hey Burger',null,135,195,array['Single','Double']::text[],1),
('برجر لحم','Black Burger',null,130,190,array['Single','Double']::text[],2),
('برجر لحم','Thousand Burger',null,125,185,array['Single','Double']::text[],3),
('برجر لحم','Cheese Burger',null,120,180,array['Single','Double']::text[],4),
('برجر لحم','Sweet & Sour Burger',null,145,205,array['Single','Double']::text[],5),
('برجر لحم','Ranch Burger',null,145,210,array['Single','Double']::text[],6),
('برجر لحم','Smoked Burger',null,140,205,array['Single','Double']::text[],7),
('برجر لحم','Hot Touch Burger',null,140,200,array['Single','Double']::text[],8),
('برجر لحم','Honey Caramel Burger',null,165,240,array['Single','Double']::text[],9),
('برجر لحم','Bistro Burger',null,160,215,array['Single','Double']::text[],10),
('برجر لحم','Cheese Lover Burger',null,140,215,array['Single','Double']::text[],11),
('برجر لحم','Beef Burger',null,150,210,array['Single','Double']::text[],12),
('برجر لحم','Mushroom Burger',null,185,250,array['Single','Double']::text[],13),
('برجر لحم','Samurai Burger',null,170,245,array['Single','Double']::text[],14),
-- Chicken burgers
('برجر دجاج','Black Chicken Burger',null,145,210,array['Single','Double']::text[],1),
('برجر دجاج','Chicken Burger',null,140,200,array['Single','Double']::text[],2),
('برجر دجاج','Chicken Waw Burger',null,135,195,array['Single','Double']::text[],3),
('برجر دجاج','Cheese Chicken Burger',null,130,195,array['Single','Double']::text[],4),
('برجر دجاج','Baco Chicken Burger',null,155,215,array['Single','Double']::text[],5),
('برجر دجاج','Smoked Chicken Burger',null,150,210,array['Single','Double']::text[],6),
('برجر دجاج','Chicken Sweet & Sour Burger',null,150,210,array['Single','Double']::text[],7),
('برجر دجاج','Chicken Hot Touch Burger',null,145,205,array['Single','Double']::text[],8),
('برجر دجاج','Honey Caramel Chicken Burger',null,170,235,array['Single','Double']::text[],9),
('برجر دجاج','Cheese Lover Chicken Burger',null,165,220,array['Single','Double']::text[],10),
('برجر دجاج','Bistro Chicken Burger',null,165,220,array['Single','Double']::text[],11),
('برجر دجاج','Ranch Chicken Burger',null,160,220,array['Single','Double']::text[],12),
('برجر دجاج','Mushroom Chicken Burger',null,190,260,array['Single','Double']::text[],13),
('برجر دجاج','Samurai Chicken Burger',null,180,250,array['Single','Double']::text[],14),
-- Wheat bran sandwiches
('سندوتشات الردة','كفتة',60,null,null,'{}'::text[],1),
('سندوتشات الردة','سجق',45,null,null,'{}'::text[],2),
('سندوتشات الردة','كبدة',45,null,null,'{}'::text[],3),
('سندوتشات الردة','هوت دوج',45,null,null,'{}'::text[],4),
('سندوتشات الردة','بطاطس',30,null,null,'{}'::text[],5),
('سندوتشات الردة','فاهيتا',60,null,null,'{}'::text[],6),
('سندوتشات الردة','تشيكن ستربس',70,null,null,'{}'::text[],7),
-- Hawawshi
('حواوشي','أبو لحمة',110,null,null,'{}'::text[],1),
('حواوشي','بيسترو',120,null,null,'{}'::text[],2),
('حواوشي','رومي',100,null,null,'{}'::text[],3),
('حواوشي','سجق',55,null,null,'{}'::text[],4),
('حواوشي','لحمة',60,null,null,'{}'::text[],5),
('حواوشي','إنكل حواوشي',140,null,null,'{}'::text[],6),
-- Meals
('وجبات','شاورما عربي',150,null,null,'{}'::text[],1),
('وجبات','ستربس',140,null,null,'{}'::text[],2),
('وجبات','كفتة',135,null,null,'{}'::text[],3),
('وجبات','كبدة',100,null,null,'{}'::text[],4),
('وجبات','فرخة كاملة مشوية',470,null,null,'{}'::text[],5),
('وجبات','نصف فرخة مشوية',240,null,null,'{}'::text[],6),
('وجبات','ربع فرخة مشوية',120,null,null,'{}'::text[],7),
('وجبات','شيش طاووق',140,null,null,'{}'::text[],8),
('وجبات','بوكس 10 ستربس',420,null,null,'{}'::text[],9),
('وجبات','بوكس 5 ستربس',220,null,null,'{}'::text[],10),
('وجبات','بوكس 3 ستربس',140,null,null,'{}'::text[],11),
-- Pizza
('بيتزا','Chicken BBQ Pizza',180,null,null,'{}'::text[],1),
('بيتزا','Chicken & Ranch Pizza',185,null,null,'{}'::text[],2),
('بيتزا','Margherita Pizza',120,null,null,'{}'::text[],3),
('بيتزا','Sausage Pizza',160,null,null,'{}'::text[],4),
('بيتزا','Four Cheese Pizza',200,null,null,'{}'::text[],5),
('بيتزا','Chicken Strips Pizza',195,null,null,'{}'::text[],6),
('بيتزا','Bistro Pizza',240,null,null,'{}'::text[],7),
('بيتزا','Shrimp Pizza',300,null,null,'{}'::text[],8),
('بيتزا','Pastrami Pizza',230,null,null,'{}'::text[],9),
('بيتزا','Pepperoni Pizza',200,null,null,'{}'::text[],10)
)
insert into public.restaurant_menu_items(
 restaurant_id,menu_id,name,normalized_name,category,default_price,single_price,double_price,weight_options,active,sort_order
)
select r.id,m.id,s.name,lower(trim(s.name)),s.category,s.price,s.single_price,s.double_price,s.weight_options,true,s.sort_order
from seed s
join public.restaurants r on lower(trim(r.name))='bistro'
join public.restaurant_menus m on m.restaurant_id=r.id and m.name='Bistro'
on conflict(menu_id,normalized_name) do update set
 category=excluded.category,
 default_price=excluded.default_price,
 single_price=excluded.single_price,
 double_price=excluded.double_price,
 weight_options=excluded.weight_options,
 active=true,
 sort_order=excluded.sort_order;

commit;

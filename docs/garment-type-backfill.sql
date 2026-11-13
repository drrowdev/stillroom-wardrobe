-- CAPS1a: the one-off, owner-reviewed backfill of garment types for garments saved before the type existed (docs/cloud-development.md).
-- It costs nothing and calls no provider: the type is read from the garment's own name (title) and style details (subcategory) by the
-- ordered rules below. A garment whose name says nothing clear stays "not set". The coordinator runs it per account, once the migration
-- 20261113090000_garment_type.sql is installed AND the new Pages build is live and the app has been reloaded (see the rollout in the guide).
-- Replace the two angle-bracket placeholders in the code lines (never in a comment): the owner one with the account's user id, in both parts,
-- and the reviewed one with the reviewed proposals, in part 2 only.
--
--   PART 1 is read-only. It prints one JSON object: "proposals" (id, version, category, title, proposed type) and "unmatched" (the
--   garments that stay not set, with their names). Read it; delete any proposal that is wrong from the list.
--   PART 2 writes. Paste the reviewed "proposals" array as the reviewed placeholder's value. For each reviewed garment it sets only garment_type, and only
--   while the garment is still exactly what was reviewed (see the guards below). A garment that changed since the review is skipped.
--
-- What is never touched, in either part: a garment that is not saved with a ready photo, is in Trash, is being deleted, has an unfinished
-- save or photo replacement, already has a type, or whose type the owner has set or cleared (a provenance entry of kind user, which also
-- covers a type cleared back to "not set"). No consent, control, usage, image or other column is written. The garment's version goes up by
-- one and the type is recorded as unknown (set by the system, not by the owner), through the ordinary item triggers, which stay enabled.
-- Running part 2 again changes nothing: every garment it set now has a type.
--
-- The rules are the same in both parts (a test compares the two copies). They read the lower-cased name whole words only, English first, then
-- Finnish and Swedish; the first matching rule of the garment's own category wins, so the order is the precedence (shorts before jeans, polo
-- before shirt, vest before puffer, shell before jacket).

-- == PART 1: DRY RUN (nothing is kept: it ends with a rollback) ==
begin;
create function pg_temp.caps_type(p_category text,p_title text,p_style text) returns text
language sql stable as $f$
  select r.type from (values
    (1,'top','polo','\m(polo|pique|pikee|pikeepaita|pikétröja|piketröja)\M'),
    (2,'top','t_shirt','\m(t-shirt|tshirt|t shirt|tee|t-paita|t-tröja|t-troja)\M'),
    (3,'top','sweatshirt','\m(sweatshirt|sweat shirt|crewneck|collegepaita|collegetröja|collegetroja)\M'),
    (4,'top','tank','\m(tank|singlet|camisole|toppi|linne)\M'),
    (5,'top','knit','\m(knit|knitted|jumper|sweater|pullover|neule|neulepusero|stickad|stickat)\M'),
    (6,'top','shirt','\m(shirt|button-down|button-up|button down|button up|blouse|paita|kauluspaita|skjorta|blus)\M'),
    (1,'bottom','shorts','\m(shorts|shortsit)\M'),
    (2,'bottom','skirt','\m(skirt|hame|kjol)\M'),
    (3,'bottom','jeans','\m(jeans|denim|farkut|farkkuhousut)\M'),
    (4,'bottom','chinos','\m(chinos|chino|chinot)\M'),
    (5,'bottom','trousers','\m(trousers|pants|slacks|cords|corduroy|housut|byxor)\M'),
    (1,'one_piece','dress','\m(dress|mekko|klänning|klanning)\M'),
    (2,'one_piece','jumpsuit','\m(jumpsuit|playsuit|romper|overalls|haalari|byxdress)\M'),
    (1,'footwear','sneakers','\m(sneakers|sneaker|trainers|trainer|lenkkarit|lenkkari|tennarit|gymnastikskor)\M'),
    (2,'footwear','boots','\m(boots|boot|chelsea|saappaat|saapas|kängor|känga)\M'),
    (3,'footwear','sandals','\m(sandals|sandal|sandaalit|sandaali|sandaler|sandal)\M'),
    (4,'footwear','shoes','\m(shoes|shoe|loafers|kengät|kenkä|skor|sko)\M'),
    (1,'layer','hoodie','\m(hoodie|hoody|hooded sweatshirt|huppari|huvtröja|huvtroja)\M'),
    (2,'layer','sweatshirt','\m(sweatshirt|sweat shirt|collegepaita|collegetröja|collegetroja)\M'),
    (3,'layer','blazer','\m(blazer|sport coat|suit jacket|bleiseri|kavaj)\M'),
    (4,'layer','cardigan','\m(cardigan|neuletakki|kofta)\M'),
    (5,'layer','vest','\m(vest|gilet|waistcoat|liivi|väst|vast)\M'),
    (6,'layer','overshirt','\m(overshirt|flannel|shacket|shirt jacket|paitatakki|flanelli|flanell|överskjorta)\M'),
    (7,'layer','knit','\m(knit|knitted|jumper|sweater|pullover|neule|stickad|stickat)\M'),
    (1,'outerwear','vest','\m(vest|gilet|waistcoat|liivi|väst|vast)\M'),
    (2,'outerwear','parka','\m(parka|parkatakki|parkas)\M'),
    (3,'outerwear','shell','\m(shell|windbreaker|anorak|rain jacket|raincoat|kuoritakki|skaljacka|regnjacka|sadetakki)\M'),
    (4,'outerwear','puffer','\m(puffer|down|padded|quilted|toppatakki|täckjacka|pufferjacka)\M'),
    (5,'outerwear','bomber','\m(bomber|bomber-takki|bomberjacka)\M'),
    (6,'outerwear','overshirt','\m(overshirt|shacket|flannel|paitatakki|överskjorta)\M'),
    (7,'outerwear','coat','\m(coat|overcoat|trench|päällystakki|villakangastakki|kappa)\M'),
    (8,'outerwear','jacket','\m(jacket|blouson|takki|jacka)\M'),
    (1,'accessory','hat','\m(hat|cap|beanie|hattu|lippis|pipo|mössa|hatt|keps)\M'),
    (2,'accessory','scarf','\m(scarf|shawl|huivi|kaulaliina|halsduk|sjal)\M'),
    (3,'accessory','belt','\m(belt|vyö|bälte|balte)\M'),
    (4,'accessory','bag','\m(bag|backpack|tote|laukku|reppu|väska|vaska|ryggsäck)\M')
  ) as r(ord,category,type,re)
  where r.category=p_category and lower(coalesce(p_title,'')||' '||coalesce(p_style,'')) ~ r.re
  order by r.ord limit 1;
$f$;
select jsonb_build_object(
  'proposals',coalesce((select jsonb_agg(jsonb_build_object('id',x.id,'version',x.version,'category',x.category,'title',x.title,'type',x.proposed)
      order by x.category,x.title,x.id) from (
    select i.id,i.version,i.category,i.title,pg_temp.caps_type(i.category,i.title,i.subcategory) as proposed
    from public.items i
    where i.owner_id='<owner>'::uuid and i.deleted_at is null and i.garment_type is null
      and coalesce(i.field_provenance->'garment_type'->>'kind','unknown')<>'user'
      and exists(select 1 from public.item_images m where m.owner_id=i.owner_id and m.item_id=i.id and m.state='ready')
      and not exists(select 1 from private.item_save_attempts s where s.owner_id=i.owner_id and s.item_id=i.id and s.state='reserved')
      and not exists(select 1 from private.image_change_attempts c where c.owner_id=i.owner_id and c.item_id=i.id and c.state='reserved')
      and not exists(select 1 from private.item_deletion_claims d where d.owner_id=i.owner_id and d.item_id=i.id)
      and not private.image_change_fenced(i.owner_id,i.id)) x where x.proposed is not null),'[]'::jsonb),
  'unmatched',coalesce((select jsonb_agg(jsonb_build_object('id',y.id,'category',y.category,'title',y.title) order by y.category,y.title,y.id) from (
    select i.id,i.category,i.title,pg_temp.caps_type(i.category,i.title,i.subcategory) as proposed
    from public.items i
    where i.owner_id='<owner>'::uuid and i.deleted_at is null and i.garment_type is null
      and coalesce(i.field_provenance->'garment_type'->>'kind','unknown')<>'user'
      and exists(select 1 from public.item_images m where m.owner_id=i.owner_id and m.item_id=i.id and m.state='ready')) y where y.proposed is null),'[]'::jsonb))::text;
rollback;

-- == PART 2: APPLY (writes; needs the reviewed proposals) ==
begin;
create function pg_temp.caps_type(p_category text,p_title text,p_style text) returns text
language sql stable as $f$
  select r.type from (values
    (1,'top','polo','\m(polo|pique|pikee|pikeepaita|pikétröja|piketröja)\M'),
    (2,'top','t_shirt','\m(t-shirt|tshirt|t shirt|tee|t-paita|t-tröja|t-troja)\M'),
    (3,'top','sweatshirt','\m(sweatshirt|sweat shirt|crewneck|collegepaita|collegetröja|collegetroja)\M'),
    (4,'top','tank','\m(tank|singlet|camisole|toppi|linne)\M'),
    (5,'top','knit','\m(knit|knitted|jumper|sweater|pullover|neule|neulepusero|stickad|stickat)\M'),
    (6,'top','shirt','\m(shirt|button-down|button-up|button down|button up|blouse|paita|kauluspaita|skjorta|blus)\M'),
    (1,'bottom','shorts','\m(shorts|shortsit)\M'),
    (2,'bottom','skirt','\m(skirt|hame|kjol)\M'),
    (3,'bottom','jeans','\m(jeans|denim|farkut|farkkuhousut)\M'),
    (4,'bottom','chinos','\m(chinos|chino|chinot)\M'),
    (5,'bottom','trousers','\m(trousers|pants|slacks|cords|corduroy|housut|byxor)\M'),
    (1,'one_piece','dress','\m(dress|mekko|klänning|klanning)\M'),
    (2,'one_piece','jumpsuit','\m(jumpsuit|playsuit|romper|overalls|haalari|byxdress)\M'),
    (1,'footwear','sneakers','\m(sneakers|sneaker|trainers|trainer|lenkkarit|lenkkari|tennarit|gymnastikskor)\M'),
    (2,'footwear','boots','\m(boots|boot|chelsea|saappaat|saapas|kängor|känga)\M'),
    (3,'footwear','sandals','\m(sandals|sandal|sandaalit|sandaali|sandaler|sandal)\M'),
    (4,'footwear','shoes','\m(shoes|shoe|loafers|kengät|kenkä|skor|sko)\M'),
    (1,'layer','hoodie','\m(hoodie|hoody|hooded sweatshirt|huppari|huvtröja|huvtroja)\M'),
    (2,'layer','sweatshirt','\m(sweatshirt|sweat shirt|collegepaita|collegetröja|collegetroja)\M'),
    (3,'layer','blazer','\m(blazer|sport coat|suit jacket|bleiseri|kavaj)\M'),
    (4,'layer','cardigan','\m(cardigan|neuletakki|kofta)\M'),
    (5,'layer','vest','\m(vest|gilet|waistcoat|liivi|väst|vast)\M'),
    (6,'layer','overshirt','\m(overshirt|flannel|shacket|shirt jacket|paitatakki|flanelli|flanell|överskjorta)\M'),
    (7,'layer','knit','\m(knit|knitted|jumper|sweater|pullover|neule|stickad|stickat)\M'),
    (1,'outerwear','vest','\m(vest|gilet|waistcoat|liivi|väst|vast)\M'),
    (2,'outerwear','parka','\m(parka|parkatakki|parkas)\M'),
    (3,'outerwear','shell','\m(shell|windbreaker|anorak|rain jacket|raincoat|kuoritakki|skaljacka|regnjacka|sadetakki)\M'),
    (4,'outerwear','puffer','\m(puffer|down|padded|quilted|toppatakki|täckjacka|pufferjacka)\M'),
    (5,'outerwear','bomber','\m(bomber|bomber-takki|bomberjacka)\M'),
    (6,'outerwear','overshirt','\m(overshirt|shacket|flannel|paitatakki|överskjorta)\M'),
    (7,'outerwear','coat','\m(coat|overcoat|trench|päällystakki|villakangastakki|kappa)\M'),
    (8,'outerwear','jacket','\m(jacket|blouson|takki|jacka)\M'),
    (1,'accessory','hat','\m(hat|cap|beanie|hattu|lippis|pipo|mössa|hatt|keps)\M'),
    (2,'accessory','scarf','\m(scarf|shawl|huivi|kaulaliina|halsduk|sjal)\M'),
    (3,'accessory','belt','\m(belt|vyö|bälte|balte)\M'),
    (4,'accessory','bag','\m(bag|backpack|tote|laukku|reppu|väska|vaska|ryggsäck)\M')
  ) as r(ord,category,type,re)
  where r.category=p_category and lower(coalesce(p_title,'')||' '||coalesce(p_style,'')) ~ r.re
  order by r.ord limit 1;
$f$;
do $apply$
declare
  v_owner constant uuid := '<owner>';
  v_reviewed constant jsonb := '<reviewed>'::jsonb;
  e jsonb; v_set integer := 0; v_skipped integer := 0;
begin
  if jsonb_typeof(v_reviewed)<>'array' or jsonb_array_length(v_reviewed)>1000 then
    raise exception 'garment type backfill: the reviewed list must be a JSON array of at most 1000 proposals';
  end if;
  perform 1 from public.profiles where owner_id=v_owner for update;
  if not found then raise exception 'garment type backfill: no such account'; end if;
  for e in select value from jsonb_array_elements(v_reviewed) loop
    if jsonb_typeof(e)<>'object' or coalesce(e->>'id','')!~'^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
      or jsonb_typeof(e->'version') is distinct from 'number' or jsonb_typeof(e->'type') is distinct from 'string' then
      raise exception 'garment type backfill: a reviewed proposal is malformed';
    end if;
    update public.items i set garment_type=e->>'type'
    where i.owner_id=v_owner and i.id=(e->>'id')::uuid and i.version=(e->>'version')::bigint
      and i.deleted_at is null and i.garment_type is null
      and coalesce(i.field_provenance->'garment_type'->>'kind','unknown')<>'user'
      and exists(select 1 from public.item_images m where m.owner_id=i.owner_id and m.item_id=i.id and m.state='ready')
      and not exists(select 1 from private.item_save_attempts s where s.owner_id=i.owner_id and s.item_id=i.id and s.state='reserved')
      and not exists(select 1 from private.image_change_attempts c where c.owner_id=i.owner_id and c.item_id=i.id and c.state='reserved')
      and not exists(select 1 from private.item_deletion_claims d where d.owner_id=i.owner_id and d.item_id=i.id)
      and not private.image_change_fenced(i.owner_id,i.id)
      and pg_temp.caps_type(i.category,i.title,i.subcategory) is not distinct from e->>'type';
    if found then v_set := v_set+1; else v_skipped := v_skipped+1; end if;
  end loop;
  raise notice 'garment type backfill: % set, % skipped (changed since the review, already typed, or not eligible)',v_set,v_skipped;
end
$apply$;
commit;

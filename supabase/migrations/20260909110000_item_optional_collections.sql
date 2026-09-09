begin;

alter table public.items
  drop constraint items_colours_check,
  add constraint items_colours_check check (cardinality(colours) between 0 and 3),
  drop constraint items_seasons_check,
  add constraint items_seasons_check
    check (cardinality(seasons) between 0 and 4 and seasons <@ array['spring','summer','autumn','winter']::text[]),
  alter column colours set default '{}'::text[],
  alter column seasons set default '{}'::text[];

commit;

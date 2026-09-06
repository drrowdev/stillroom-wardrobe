\set ON_ERROR_STOP on
begin;
do $$
begin
  if exists (
    select 1 from private.approved_accounts
    where (admission_no = 1 and email <> 'user-a@example.test')
       or (admission_no = 2 and email <> 'user-b@example.test')
  ) or exists (
    select 1 from auth.users
    where email is null or email not in ('user-a@example.test', 'user-b@example.test')
  ) then
    raise exception 'Disposable fixture identity mismatch';
  end if;
end
$$;
-- These are fictional local-only slots, reserved before any Auth admin creation.
insert into private.approved_accounts (admission_no, email)
values (1, 'user-a@example.test'), (2, 'user-b@example.test')
on conflict (admission_no) do nothing;
select coalesce(jsonb_agg(jsonb_build_object('slot', admission_no, 'created', user_id is not null)
  order by admission_no), '[]'::jsonb) from private.approved_accounts;
commit;

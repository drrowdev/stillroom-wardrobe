// BUDGET2: the guarded owner-controls switch between the two analysis manifests, as one SQL transaction for the operator.
// Nothing here connects anywhere or runs: it only builds text. The preservation rehearsal executes the same text against
// its local fixture database; the hosted run is a separately authorised coordinator step.
//
// forward  v2 (hold 4,097,351) -> v3 (hold 1)
// rollback v3 -> v2
// Both directions use the same quiescence guards and refuse with BLOCKED, before any write, unless
//   * the controls are exactly the expected current row,
//   * no frozen analysed Save or image replacement of the account is still in progress (a frozen attempt finishes under the
//     manifest it was frozen with, so it is reported apart from an unreserved ready analysis),
//   * no request of the account is alive: neither one in flight nor a ready analysis that was never saved (its manifest would
//     no longer match the controls after the switch, so it could not be saved), and
//   * no reserved or held charge exists. A dispatched request that expired keeps its held charge, so it blocks too: the switch
//     never erases an unknown charge to pass the guard, and reconciling one is a separately authorised step.
// Rollback restores the controls before Edge and Pages are downgraded. Activation, consent, notice, prompt, allowance and every
// other column are never written.
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export const SWITCH_PROFILES = Object.freeze({
  v2: Object.freeze({ manifest: 'azure-eu-terra-devtest-v2', maxRequestMicro: 4097351 }),
  v3: Object.freeze({ manifest: 'azure-eu-terra-devtest-v3', maxRequestMicro: 1 }),
});

export function switchControlsSql(ownerId, direction) {
  if (typeof ownerId !== 'string' || !UUID.test(ownerId)) throw new Error('Invalid owner id.');
  if (direction !== 'forward' && direction !== 'rollback') throw new Error('Invalid direction.');
  const from = direction === 'forward' ? SWITCH_PROFILES.v2 : SWITCH_PROFILES.v3;
  const to = direction === 'forward' ? SWITCH_PROFILES.v3 : SWITCH_PROFILES.v2;
  return `begin;
do $switch$
declare p public.profiles; c private.ai_controls;
begin
  select * into p from public.profiles where owner_id='${ownerId}' for update;
  if not found then raise exception 'BLOCKED: no profile'; end if;
  select * into c from private.ai_controls where owner_id=p.owner_id for update;
  if not found or c.execution_manifest_id is distinct from '${from.manifest}' or c.max_request_micro<>${from.maxRequestMicro}
    or c.prompt_version<>2 or c.notice_revision<>2 or c.model_id<>'gpt-5.6-terra-2026-07-09' then
    raise exception 'BLOCKED: the controls are not the expected current row';
  end if;
  if exists(select 1 from private.ai_item_save_attempts a join private.item_save_attempts s
      on s.owner_id=a.owner_id and s.item_id=a.item_id
    where a.owner_id=p.owner_id and a.manifest_id is not null and s.state='reserved')
    or exists(select 1 from private.image_change_attempts i where i.owner_id=p.owner_id and i.manifest_id is not null and i.state='reserved') then
    raise exception 'BLOCKED: a frozen analysed Save or image replacement is still in progress';
  end if;
  if exists(select 1 from private.ai_requests where owner_id=p.owner_id and status='ready' and expires_at>clock_timestamp()) then
    raise exception 'BLOCKED: an unsaved ready analysis is still alive';
  end if;
  if exists(select 1 from private.ai_requests where owner_id=p.owner_id and expires_at>clock_timestamp()) then
    raise exception 'BLOCKED: a request of this account is still alive';
  end if;
  if exists(select 1 from private.ai_usage where owner_id=p.owner_id and charge_state in ('reserved','held')) then
    raise exception 'BLOCKED: reserved or held charge exists (an expired dispatched request keeps its held charge)';
  end if;
  update private.ai_controls set execution_manifest_id='${to.manifest}',max_request_micro=${to.maxRequestMicro},
    updated_at=clock_timestamp() where owner_id=p.owner_id;
end
$switch$;
commit;
`;
}

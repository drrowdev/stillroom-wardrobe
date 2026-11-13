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
//   * no reserved or held charge exists, except one exact kind of dead debris (below). A dispatched request that expired keeps
//     its held charge, so it blocks too: the switch never erases an unknown charge to pass the guard, and reconciling one is a
//     separately authorised step.
// The only held charge that is ignored is the one the old anomaly kill switch left behind, and ONLY when every part holds:
//   analysis purpose, state held, a period earlier than the current UTC month, closed (closed_reason set), no private.ai_requests
//   row, and Azure v2 evidence with anomaly=true and no normalized usage. A late ai_finish_analysis for such a row stops at
//   USAGE_CONFLICT before it changes anything, so it can neither re-account the charge nor switch the account's CURRENT controls
//   off after this switch. Any other reserved or held row (another purpose, an ordinary expired hold that a late finish could
//   still settle, the current or a future month, unclosed, a request still present, other evidence) still blocks all of it.
//   The ignored row is not cleaned: it stays in the shared monthly admission sum and in the current-use displays.
// One timestamp is taken after both locks; the period and the liveness cutoff are both derived from it, in UTC whatever the
// session time zone is. Rollback restores the controls before Edge and Pages are downgraded. Activation, consent, notice,
// prompt, allowance and every other column are never written.
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

// The current UTC month as the rest of the schema derives it; v_now is the one timestamp taken after the locks.
export const CURRENT_PERIOD_SQL = "to_char(v_now at time zone 'UTC','YYYY-MM')";

export const SWITCH_PROFILES = Object.freeze({
  v2: Object.freeze({ manifest: 'azure-eu-terra-devtest-v2', maxRequestMicro: 4097351, promptVersion: 2 }),
  v3: Object.freeze({ manifest: 'azure-eu-terra-devtest-v3', maxRequestMicro: 1, promptVersion: 2 }),
  // CAPS1a: the garment type analysis (prompt version 3). The switch moves between v3 and v4 with switchManifestSql below.
  v4: Object.freeze({ manifest: 'azure-eu-terra-devtest-v4', maxRequestMicro: 1, promptVersion: 3 }),
});

export function switchControlsSql(ownerId, direction) {
  if (typeof ownerId !== 'string' || !UUID.test(ownerId)) throw new Error('Invalid owner id.');
  if (direction !== 'forward' && direction !== 'rollback') throw new Error('Invalid direction.');
  const from = direction === 'forward' ? SWITCH_PROFILES.v2 : SWITCH_PROFILES.v3;
  const to = direction === 'forward' ? SWITCH_PROFILES.v3 : SWITCH_PROFILES.v2;
  return build(ownerId, from, to, false);
}

// CAPS1a: the same guarded transaction between two named profiles, "from" and "to", each one of v2, v3 and v4. It additionally
// requires the target manifest to be installed with that prompt version, and it writes the prompt version with the manifest and
// the amount, because v3 and v4 differ in it. The direction pair v3 -> v4 is the rollout and v4 -> v3 the rollback; moving to or
// from v2 stays with switchControlsSql. Activation, consent, notice, allowance, limits and the spending guard's pause are never written.
export function switchManifestSql(ownerId, fromKey, toKey) {
  if (typeof ownerId !== 'string' || !UUID.test(ownerId)) throw new Error('Invalid owner id.');
  const known = ['v3', 'v4'];
  if (!known.includes(fromKey) || !known.includes(toKey) || fromKey === toKey) throw new Error('Invalid switch.');
  return build(ownerId, SWITCH_PROFILES[fromKey], SWITCH_PROFILES[toKey], true);
}

function build(ownerId, from, to, explicit) {
  return `begin;
do $switch$
declare p public.profiles; c private.ai_controls; v_now timestamptz;
begin
  select * into p from public.profiles where owner_id='${ownerId}' for update;
  if not found then raise exception 'BLOCKED: no profile'; end if;
  select * into c from private.ai_controls where owner_id=p.owner_id for update;
  if not found or c.execution_manifest_id is distinct from '${from.manifest}' or c.max_request_micro<>${from.maxRequestMicro}
    or c.prompt_version<>${from.promptVersion} or c.notice_revision<>2 or c.model_id<>'gpt-5.6-terra-2026-07-09' then
    raise exception 'BLOCKED: the controls are not the expected current row';
  end if;
${explicit ? `  if not exists(select 1 from private.ai_execution_manifests where id='${to.manifest}' and prompt_version=${to.promptVersion}) then
    raise exception 'BLOCKED: the target manifest is not installed';
  end if;
` : ''}  v_now := clock_timestamp();
  if exists(select 1 from private.ai_item_save_attempts a join private.item_save_attempts s
      on s.owner_id=a.owner_id and s.item_id=a.item_id
    where a.owner_id=p.owner_id and a.manifest_id is not null and s.state='reserved')
    or exists(select 1 from private.image_change_attempts i where i.owner_id=p.owner_id and i.manifest_id is not null and i.state='reserved') then
    raise exception 'BLOCKED: a frozen analysed Save or image replacement is still in progress';
  end if;
  if exists(select 1 from private.ai_requests where owner_id=p.owner_id and status='ready' and expires_at>v_now) then
    raise exception 'BLOCKED: an unsaved ready analysis is still alive';
  end if;
  if exists(select 1 from private.ai_requests where owner_id=p.owner_id and expires_at>v_now) then
    raise exception 'BLOCKED: a request of this account is still alive';
  end if;
  if exists(select 1 from private.ai_usage u where u.owner_id=p.owner_id and u.charge_state in ('reserved','held')
    and not (u.charge_state='held' and u.purpose='analysis' and u.period<${CURRENT_PERIOD_SQL} and u.closed_reason is not null
      and not exists(select 1 from private.ai_requests r where r.owner_id=u.owner_id and r.request_id=u.request_id)
      and exists(select 1 from private.ai_usage_evidence e where e.owner_id=u.owner_id and e.request_id=u.request_id
        and e.manifest_id='${SWITCH_PROFILES.v2.manifest}' and e.anomaly and e.normalized_usage is null))) then
    raise exception 'BLOCKED: reserved or held charge exists (an expired dispatched request keeps its held charge; only a closed Azure v2 anomaly hold of an earlier month, with no request, is ignored)';
  end if;
  update private.ai_controls set execution_manifest_id='${to.manifest}',max_request_micro=${to.maxRequestMicro},${explicit ? `prompt_version=${to.promptVersion},
    ` : ''}
    updated_at=clock_timestamp() where owner_id=p.owner_id;
end
$switch$;
commit;
`;
}

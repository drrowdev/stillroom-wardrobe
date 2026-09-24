# Phase 5 result: I17 owner-isolation audit (partial)

Status: **engineering in review; partial.** This document covers packet I17 only.
Neither I16 nor Phase 5 acceptance is claimed. The live database/security run
happens only in CI (`database` job, `npm run test:security`); local builder
validation was limited to lint, typecheck, translations, unit tests and
`node --check`.

- Base: `6abfadb2ad819374211ca15d8c3e789d3622b564` (origin/main).
- Requirements: R11, R12, R19, R26; blueprint `15` I17, `14` Phase 5,
  `12` cases 1–5, `10` security/privacy, `07` RLS.
- Scope: the current export (schema v2) and completed features only. No schema,
  migration, CI workflow or application source change.

## What runs

`npm run test:security` keeps its existing suites. After them, the runner:

1. runs the closed read-only catalogue (`scripts/isolation-catalog.mjs catalog`)
   and fails on any unknown or changed entry;
2. starts one long-lived normal-session child
   (`tests/security/isolation-audit.sessions.mjs`) that holds both tokens,
   fixtures and baselines for the whole audit;
3. serves bounded `freeze`/`restore` phase requests from that child for the
   fixed fictional owners A and B only, inside a 12-minute deadline with a
   2-minute restore reserve. Restore always runs for every touched owner, and
   both the primary and any restore failure are reported.

The privileged helper accepts no SQL, no identity and no credential. Before any
SQL it requires: no service secret; the CI job/repository/opt-in flags; no
`DOCKER_HOST`/`DOCKER_CONTEXT`/`DOCKER_TLS*`/`PG*` override; a loopback API;
`project_id = "stillroom-wardrobe"`; a local Docker socket or pipe; and the
exact running `supabase_db_stillroom-wardrobe` container on the Supabase
Postgres image. Its environment gets only the guard flags. All isolation,
unchanged-data and byte assertions use normal-session HTTP.

## Catalogue (A1)

Inventory by schema, name and argument types:

- 39 exposed public RPCs, each with an exact anon/authenticated/PUBLIC
  `EXECUTE` expectation; the OpenAPI RPC list is compared with this subset only;
- 9 service-only public functions (normal sessions and anon are also denied
  over HTTP);
- 4 private policy helpers (`is_approved`, `owns_storage_path(text,boolean)`,
  `may_delete_storage(text)`, `may_create_item_object(text)`) with their body
  MD5 derived from the latest migration definition;
- private internal functions and provider infrastructure, none executable by
  normal roles;
- 10 public and 21 private tables with RLS, table and column grants for PUBLIC,
  anon and authenticated; no unexpected views or materialized views;
- the owner policies on each public table, `storage.objects` RLS and all three
  Storage policies (read, create, delete); the `wardrobe` bucket is private;
- schema USAGE/CREATE, realtime publications, owner-scoped composite foreign
  keys and relationship-like column names.

GraphQL `Connection`/`Edge` pagination types are not treated as relationships.

## Foreign-ID matrix (A2)

`COVERAGE_REQUIREMENTS` in the catalogue module lists, for every exposed RPC,
the fixture references to substitute and any mixed-array, collision or
owner-only case. In both directions (A→B and B→A):

- the attacker's own call on its own fixture, in the state where it would act,
  must succeed first (the owned control); without it the RPC fails coverage;
- each reference is substituted on its own with the peer's value (plus only the
  peer values that state needs, such as a version), the rest stay the
  attacker's, and the nonexistent counterpart randomizes only that reference;
- lookups must return the family's exact response for the peer ID **and** the
  same response for the nonexistent ID (masked for the substituted IDs):
  description edit `42501 Not available`; lifecycle `22023 Request conflict`;
  AI status/discard `200 {code:'UNAVAILABLE'}`; image/deletion operation status
  `null`; deletion arrays `[]`; finish deletion `[{state:'absent'}]`;
- mixed own+peer arrays must return only the owner's entry or the exact
  refusal;
- `ai_set_consent` is called with `p_notice_revision: null` and a stale
  version and must return exactly `200 {code:'CONFLICT'}`; application codes
  inside HTTP 200 are validated, never inferred from HTTP success;
- every response is scanned for the peer's IDs, paths and canary text;
  reflected inputs (the caller's own `export_manifest` ID, owner-local nonces)
  are exempt;
- each victim is snapshotted before its attacker's probes and compared after,
  including AI status and request state.

Where a state cannot be reached with normal sessions, the case is asserted but
recorded **UNVERIFIED**, never as coverage: analyzed Save
(`reserve_analyzed_item_save`, its preflight and cancel) needs a
provider-completed claim; `ai_analysis_status` needs provider evidence; the AI
request surfaces become UNVERIFIED if the owner's own reservation returns
`ALLOWANCE`, `RATE_LIMIT`, `UNCONFIGURED` or similar.

Create-ID collisions are probed separately (see Findings).
## Fixtures and positive controls (A3)

Each owner gets fictional data: items with pending, committed and retired
images and an edited description; an outfit, a wear event and its item rows, a
combination rule and suggestion feedback; a reserved image change and an item
free for a new change; a retired recovery source; deletion operations in the
trashed, preparing, prepared (inventoried) and removing-registered states,
plus legacy begin/finish and cancelled preparations as owned controls; a
reserved, uploaded save; and an owned AI reservation. Owner state includes
attribution history. `ALLOWANCE`, `RATE_LIMIT`, `UNCONFIGURED` and missing
evidence never count as ownership proof; they are reported as unverified.
The export must contain exactly the ten v2 table keys and include the owner's
fixtures, with no peer value. REST reads exhaust pagination.

Validator unit tests (`tests/unit/isolation-catalog.test.ts`) prove rejection of
unexpected functions/relations/policies, grant and column-grant changes,
helper-body changes, public buckets, cross-owner foreign keys, leaked rows,
missing coverage, a missing owned control, a missing single substitution,
credit for an unreachable state, wrong error classes, HTTP-200 application
errors, oracles outside the allowlist, restore-before-cleanup ordering and
every guard refusal before SQL.

## Freeze (A4)

For A then B: the same already-issued token is tested before, during and after
approval is disabled, as is a fresh login. While frozen, private reads return
empty or denial, and `export_manifest` returns `null`. The unaffected owner is
snapshotted immediately before the freeze and compared afterwards for stable
data and bytes, and a scratch write must still succeed. Cleanup runs only after
a confirmed restore barrier from the runner, on every path including a lost or
failed freeze/restore acknowledgement; otherwise cleanup is withheld and the
job fails.

## Completed-feature ledger (A6)

| Feature | Real normal-session backend evidence | Browser mock only |
| --- | --- | --- |
| Wardrobe, search, detail | I17 REST peer filter, pagination, PATCH/DELETE of peer rows; `tests/security/rls.sessions.mjs`; `tests/integration/wardrobe-query.spec.ts` | `wardrobe-grid`, `items`, `item-details` specs |
| Capture, AI, save | I17 matrix for `reserve_*`, `ai_*`, `commit_image`; `item-save`, `analyzed-save`, `ai-analysis`, `ai-controls` suites | `ai-photo-first`, `garment-fields`, `image-processing` specs |
| Image lifecycle | I17 matrix for image change, retire/forget, deletion operations and Storage download/sign/upload/delete/list; `image-replacement`, `item-lifecycle` suites | `images`, `item-lifecycle` specs |
| Outfits and history | I17 matrix for `save_outfit`, `save_wear_event`, `restore_history_entry`; `outfit-rpc` suite | `outfits` spec |
| Profile and preferences | I17 REST peer filter and spoofed-owner insert; `rls.sessions.mjs` | `profile` spec |
| Edge: `analyze-clothing`, `finalize-analyzed-item`, `finalize-image-change` | I17 peer-ID probes; unverified when the function is not served in `test:security` | `ai-photo-first` spec |
| Export (v2) | I17 exact keys, fixture inclusion, peer scan and frozen `null` | `recovery` spec |
| Account switch, logout, private-image caches | Unit `private-images`, `recovery` tests (no backend) | `slice`, `recovery`, `wardrobe-grid` specs |

Pending, not part of this audit: features not yet implemented (later phases),
and real-device account-switch and cache checks.

## Findings

These are reported, not patched; any fix needs its own reviewed packet. Any
existence oracle **fails the audit** unless it is named in `ACCEPTED_ORACLES`.
An accepted entry that stops reproducing is reported for removal.

Accepted pending a fix packet (known and reported on PR #47): a caller choosing
a peer's primary key gets `409 23505` instead of success, disclosing that the
ID exists. No peer data is returned.

- `save_outfit p_id`: a foreign `p_id` with null version;
- `save_wear_event p_id`: the same;
- `REST items id`: a REST `items` insert with a foreign `id`.

Not allowlisted, so they fail CI until a decision is made:

- `restore_history_entry p_id`: a foreign wear-event-item ID returns
  `400 P0001`, while a new ID inserts (`204`);
- `reserve_item_save p_item.id`: a foreign item ID returns `400 22023`, while a
  new ID reserves (`200`);
- `Storage DELETE object`: deleting a peer's object returns a different Storage
  error than deleting a nonexistent path.
## Pending

- CI `database` job evidence for this head (catalogue, matrix, freeze).
- The GPT-6 Astra code review and the coordinator's merge note.
- Edge probes remain unverified if the functions are not served in CI.
- I16 and Phase 5 acceptance; manual and device checks.

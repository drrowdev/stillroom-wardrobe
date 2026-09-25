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
- for composite references (an item with its request, image or hash) the
  complete valid peer tuple is also probed against an all-random tuple,
  because a mixed pair names no existing row and cannot test the owner check;
  the tuple is the victim's own payload (intent RPCs send the exact intent
  the victim's control accepted) and a construction check fails the probe if
  it carries any attacker-only identifier or a different intent;
  each multi-reference RPC is declared either composite or alternative;
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
missing coverage, a missing owned control, a missing single substitution, a
missing complete peer tuple, a tuple built from attacker data or an
undeclared composite requirement,
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

Each is an existence oracle only: a peer's reference and a nonexistent or new
one get different responses, but no peer content is returned. All are named in
`ACCEPTED_ORACLES` with their exact response pair (status, code and message),
and each run still prints them as `FINDING` lines. Any other differing surface,
or a changed pair on an accepted surface, fails the audit. An accepted entry
that stops reproducing is reported for removal.

| Surface | Peer-owned reference | Nonexistent or new reference |
| --- | --- | --- |
| `save_outfit p_id` (null version) | `400 P0001` Request conflict (was `409 23505` `outfits_pkey`) | `200` |
| `save_wear_event p_id` (null version) | `400 P0001` Request conflict (was `409 23505` `wear_events_pkey`) | `200` |
| `REST items id` (insert) | `409 23505` `items_pkey` | `201` |
| `REST outfits id` (insert) | `409 23505` `outfits_pkey` | `201` |
| `REST wear_events id` (insert) | `409 23505` `wear_events_pkey` | `201` |
| `REST wear_event_items id` (insert) | `409 23505` `wear_event_items_pkey` | `201` |
| `restore_history_entry p_id` | `400 P0001` Request conflict | `204` |
| `reserve_item_save p_item.id` | `400 22023` Request conflict | `200` |
| `Storage DELETE object` | `400 AccessDenied` | `400 NoSuchKey` |

### Conflict-response normalization (25 September 2026)

Source only; hosted keeps the old `save_outfit`/`save_wear_event` responses
until the owner approves applying the migration (see the development guide).

- `20260925100000_uniform_id_conflicts.sql` replaces `save_outfit` and
  `save_wear_event` (`create or replace`, same signatures and grants). Only the
  parent primary-key violation (`public.outfits`/`outfits_pkey`,
  `public.wear_events`/`wear_events_pkey`, read with `GET STACKED DIAGNOSTICS`)
  becomes `Request conflict`; everything else is re-raised unchanged, and child
  inserts stay outside the handler. Exact own replays still return the version.
- Target, for otherwise-valid conflicting creates only: a foreign ID gets the
  same full response (status, code, message, details, hint) as the caller's own
  conflicting create. The audit pins that response per surface in
  `TAKEN_ID_SURFACES`, in both directions, with foreign, own-conflict and fresh
  controls; a missing control, an unread fresh create or any field difference
  fails. REST inserts and `restore_history_entry`/`reserve_item_save` already
  matched and are now pinned the same way (reserve for both an existing save
  attempt and a plain REST-created item).
- Residual (owner question Q1): a caller that already knows another account's
  ID still learns that it is taken, because a fresh ID succeeds. These create-ID
  oracles stay in the accepted inventory, relabelled as a residual that needs a
  candidate UUID. REST inserts on `combination_rules`, `suggestion_feedback`
  and `item_images` share the same primary-key residual and are not probed
  individually. Removing it would need server-generated IDs plus owner-scoped
  idempotency keys; that option is documented, not built.
- Storage `DELETE`: the Storage service checks whether the object exists
  before RLS applies, so there is no policy-only fix for that execution path.
  It stays accepted; a probe needs the peer's full object path.
- No client classifier changes: `outfits.ts` already maps `P0001` Request
  conflict and `23505` to `changed`; `upload.ts` keeps its strict null
  details/hint check.

## Pending

- CI `database` job evidence for this head (catalogue, matrix, freeze).
- The GPT-6 Astra code review and the coordinator's merge note.
- Edge probes remain unverified if the functions are not served in CI.
- I16 and Phase 5 acceptance; manual and device checks.

## I16 weather-aware suggestions (partial)

**Implemented locally on a draft PR for review. It is not merged, deployed or
accepted by the owner.** The browser, unit and static checks listed below passed
on the local machine. The real local Supabase integration and security suites
were not run here (see its Pending list below).

- Requirements: R10 (weather is off until the owner picks a city; approximate
  coordinates only; forecast date and freshness shown; manual override; turning
  it off clears the city and the cache), R09 (suggestions still work without
  weather) and R27 (EN/FI/SV for every new string). Blueprint 09 weather rules;
  blueprint 06 (no weather table, memory cache of at most 3 hours).
- Packet: I16, Tier A. The plan was approved with GPT-6 Astra's five findings
  as binding amendments B1–B5 and coordinator decisions Q1 (Option A, no schema
  change), Q2 (manual entry and Staying in both kept) and Q3 (honest partial
  results). Rebased onto main after I15 (PR #46) and I17 (PR #47) merged.
- Provider: Open-Meteo, chosen by the owner. Free, no key, account or secret.
- Writer: one persistent local session (`claude-opus-5.5`). Node v24.19.0.

### What changed

- **No migration and no hosted database change.** The installed base profile
  columns `weather_enabled`, `weather_city`, `latitude` and `longitude` hold the
  setting. Coordinates are rounded to one decimal before saving. `updated_at`
  is not a consent time and is not described as one.
- **Profile projection.** One shared `profileColumns` list is used by the
  profile reads, the session start, the language save and recovery. A stored
  weather setting that is incomplete never rejects the profile: the app sends no
  request and offers a new search or Turn off. New weather writes are validated
  strictly and version-checked like the other profile saves.
- **Browser calls Open-Meteo directly** (geocoding and forecast), with no
  credentials, no referrer, `no-store` and a 5 s timeout. The CSP `connect-src`
  adds only the two Open-Meteo hosts. Nothing is sent on mount, typing, focus or
  a language change. Search is the consent step; the visible disclosure before
  Search names both stages and says the city and IP address go to Open-Meteo,
  and clothes and account details do not.
- **Settings card "Weather".** Search, pick a city, Use this city, Change city
  and Turn off. Turning it off clears the city and coordinates.
- **Today.** A short forecast line with the city, forecast date and time zone,
  the daytime low, rain chance, wind and the update time, with the Open-Meteo
  credit. Loading, offline, failed (Try again after a short pause) and
  incomplete states keep the ideas working.
- **Manual entry and Staying in.** Both work without a weather setting and
  override a forecast, including one that arrives later. They are kept in
  memory only and marked as entered by you. Staying in turns every weather rule
  off, including the temperature fit.
- **Engine `rules-v2`.** Blueprint 09 cold, rain and wind rules. Item warmth,
  coverage, rain and wind protection and temperature limits count only from the
  owner's own entries or, for coverage, supported AI observations; unknown
  facts are shown as a missing detail and never exclude an item or support a
  claim. Each idea says what is missing ("add a coat", "no garment is marked as
  rain-ready", "check the length") and only claims warmth, rain or wind
  suitability when it is confirmed.
- **Caching.** The forecast is kept in memory per signed-in owner for up to
  3 hours or until the city's midnight, whichever is first, keyed by city and coordinates, and dropped on a city change, Turn
  off, sign-out or owner change. One request per city is in flight at a time. Replies are read with byte ceilings (64 KiB search, 256 KiB forecast) and larger bodies are cancelled before parsing.
  Nothing weather-related goes to the service worker or browser storage.

### Export and restore

The export already includes the profile row, so `weather_enabled`, the city
and coordinates are exported (the security suite asserts non-null values). No
restore path writes them today. A future restore must not treat an imported
`weather_enabled` as fresh consent: the owner has to search and choose a city
again on the restored account.

### Validation (local)

- `npm run lint`, `npm run typecheck`: pass.
- `npm run check:translations`: 669 keys in en/fi/sv.
- `npm run test:unit`: pass, including the new `weather.test.ts` (provenance,
  profile parsing, forecast summary across time zones and midnight, the 3-hour
  lifetime, the manual range, the store, the exact provider requests and the
  generated CSP header). Under machine load `ai-schema`, `preservation` and
  `local-backend` time out at 5 s; the first two pass when run alone, and one `local-backend` timing test still timed out alone on the loaded machine (file not touched by I16).
- Playwright `weather.spec.ts`, `today.spec.ts` and `profile.spec.ts` on
  chromium, mobile and webkit-photo: 185 passed. External network is blocked
  before navigation, and the provider is mocked.
- Accessibility: axe, keyboard order, 320 px and 200 % text for the weather
  card and the forecast line.
- Bounded synthetic captures (`test-results/i16-visual/`, App job artifact
  `i16-weather-ui-<head>`): settings (en-desktop, fi-mobile), today forecast
  (en-desktop) and today unavailable (fi-mobile).

### Pending

- `tests/security/rls.sessions.mjs` weather isolation (own save, invalid
  bodies rejected, another owner's save has no effect, export) runs in the CI
  database job. There is no local Docker here.
- Coordinator visual review of the four captures.
- The owner-run Pages deploy: the new CSP only takes effect after it.
- An owner check with a real city and the real forecast service.

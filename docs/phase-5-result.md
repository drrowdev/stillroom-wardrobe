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

## WEATHER1 header weather disclosure (8 October 2026)

Status: **locally validated working diff; independent review pending.** This
owner-requested Tier B presentation packet follows R10/R17/R27 and blueprint
09/I16 weather semantics. Its source base is
`28bd7846a424aa75fd87c1cbb743c82c38a92ea0`; the historical evidence above is
preserved, not reused as WEATHER1 acceptance.

### Presentation

- Today mounts its existing stateful weather UI into an inert header slot;
  other routes have no weather widget. Opening details does not fetch again.
  The wide card beneath the page heading is removed.
  Desktop weather follows the account control visually and in keyboard order;
  the existing stacked-header navigation behavior is preserved.
- The neutral thermometer and text show the forecast's daytime **low**, a
  clearly labelled manual temperature, Indoors, or an explicit unavailable/
  unknown/loading state. There is no inferred current temperature or sky state.
- The keyboard-accessible details retain city/date/timezone, low/rain/wind,
  update time, Open-Meteo attribution and the existing Outdoors/Indoors,
  manual-entry, retry and Turn on controls. Close/Escape restore trigger focus;
  outside clicks and leaving focus close without stealing focus. Closing
  details preserves a partially entered manual temperature.
- Hook/store ownership, requests, coordinates, permissions, cache, suggestion
  rules and busy locks are unchanged. Copy is localized in English, Finnish
  and Swedish; no dependency, provider, authentication or schema change.

### Validation and remaining gates

- Pinned local Node `24.19.0` / npm `11.17.0`. The initial typecheck failed
  because locked dependencies were absent; `npm ci --ignore-scripts --no-fund`
  restored them without install scripts. npm reported two high dependency
  vulnerabilities; this packet does not change dependencies or claim a fix.
- `npm run lint`, `npm run typecheck`, `npm run check:translations` and
  `git diff --check`: pass. Translation check: 1105 keys, EN/FI/SV.
- `npm run test:unit -- tests/unit/weather-chips.test.ts tests/unit/weather-zone.test.ts tests/unit/weather.test.ts tests/unit/today-featured.test.ts tests/unit/shell-breakpoint.test.ts`:
  pass, 5 files / 32 tests.
- New tests cover truthful summaries, disclosure/focus,
  retained manual input, route lifetime, unchanged request counts, and
  EN/FI/SV header geometry at 320/390/650/651/1280 px and 200% text.
- `npm run test:browser -- tests/browser/weather.spec.ts tests/browser/today.spec.ts tests/browser/shell-layout.spec.ts --project=chromium --project=mobile --project=webkit-photo --workers=2 --retries=0 --grep-invert "bounded .*visual evidence|WEATHER1 visual"`:
  initial run, 367 passed / 2 skipped / 6 failed. The six new-test failures
  were diagnosed: the narrow panel covered the chosen outside-click target;
  WebKit pointer clicks do not focus buttons, so keyboard/focus-recovery
  checks had not established focus inside the disclosure. Tests now use an
  uncovered outside point and explicit keyboard focus. No product assertions,
  timeouts, retries, allowlists or caching were weakened or changed.
- `npm run test:browser -- tests/browser/weather.spec.ts tests/browser/shell-layout.spec.ts --project=chromium --project=mobile --project=webkit-photo --workers=2 --retries=0 --grep "WEATHER1 (Today header geometry|disclosure|closing)"`:
  15 passed, covering all six failures across all three projects. The two
  initial skips are existing desktop-WebKit safe-area checks; they are not
  passing native-device checks. The whole regression invocation was not rerun
  after these test-only corrections; the implementation source was unchanged.
- `npm run test:browser -- tests/browser/weather.spec.ts --project=chromium --project=mobile --project=webkit-photo --workers=2 --retries=0 --grep "WEATHER1 visual"`:
  24 passed. Run once, separately, with functional and axe assertions in every
  project; exactly eight PNGs written (33,012-43,043 bytes each). Browser runs
  used fixture port 5197 and synthetic inputs, with external network blocked.
- The existing fixture pipeline defines eight synthetic captures in ignored
  `test-results/weather1-visual/`: EN/FI/SV compact header at 390/1280 px,
  plus EN 320 px ready details and unavailable/manual-validation details.
  Identity checks precede scene setup so opening the phone account menu cannot
  silently close captured weather details. The implementation writer did not
  view images. Coordinator review of
  actual exact-head CI artifacts must record run/head/verdict before merge.
- Historical I16 capture tests were adapted but not run locally; their first
  post-change execution is exact-head CI.
- Independent review requested removal of the weather-specific account
  ordering override, which put the desktop weather control before the account
  control visually but after it in Tab order. The override is removed; a
  one-row desktop navigation/account/weather geometry and Tab-order check
  covers the repair.
  `npm run test:browser -- tests/browser/weather.spec.ts tests/browser/shell-layout.spec.ts --project=chromium --project=mobile --project=webkit-photo --workers=2 --retries=0 --grep "WEATHER1 (Today header geometry|disclosure|closing|desktop Tab order)"`:
  post-repair, 18 passed. `npm run lint`, `npm run typecheck`,
  `npm run check:translations` and `git diff --check` pass again; the unchanged
  pure-unit evidence above is reused for this CSS/test/documentation-only repair.
  The eight local captures above predate this CSS repair and are not evidence
  of its final visual layout. No new local screenshots will be generated;
  final exact-head CI captures and coordinator visual review remain pending.
  The focused run cleared the previous Playwright output directory; it did
  not produce replacement captures.
- Independent code review, required exact-head CI, visual acceptance, real
  provider/device checks and owner-run Pages deployment are not claimed.
  No hosted, integration/security or full browser suite ran locally.

### Exact-head CI repair

CI `37737696377` failed on published head
`5f58f70a30b84a9359669ab587ca6806ca00d172`. No Actions rerun or merge was
attempted. The coordinator approved adding only the presentation interaction
in `tests/browser/stylist.spec.ts` to the existing packet scope.

- The stylist manual-temperature privacy test still tried to use a hidden
  weather control. It now opens the disclosure first; the manual value,
  null-weather request assertion and timeouts are unchanged. Targeted
  weather-control consumer searches found no additional unadapted spec.
- The historical I16 Finnish 320 px / 200% forecast ordering check failed in
  CI. Its first local text-only diagnostic at height 900 passed: group
  `(x=33,y=224.765625,h=65.390625)`, forecast
  `(x=33,y=302.15625,h=355.953125)`, horizontal scroll/client widths both 286,
  zero page/panel scroll and no transform. That exact CI failure was not
  reproduced locally; no assertion or timeout was weakened to conceal it.
- A bounded height-568 probe demonstrated a real coupled source defect:
  the column disclosure inherited the old card's `flex-wrap: wrap`. With
  panel height 336, the forecast wrapped beside the controls:
  group `(x=33,y=389.984375,h=65.390625)`, forecast
  `(x=276.390625,y=153.375,h=355.953125)`, scroll/client widths 529/286.
  The disclosure now explicitly uses `flex-wrap: nowrap` and vertical
  scrolling. No claim is made that local font/viewport measurements prove
  the precise CI height-900 failure's cause.
- The historical assertion retains strict group-before-forecast ordering,
  measured together in one DOM snapshot, and adds horizontal containment,
  no horizontal overflow, readable text and whole 44 px button targets.
  Its Finnish zoomed forecast also checks height 568, restoring height 900
  before the existing capture path. Temporary probe logging was removed.
- `npm run test:browser -- tests/browser/weather.spec.ts --project=webkit-photo --workers=2 --retries=0 --grep "bounded I16 visual evidence.*today-forecast fi-320-200"`:
  post-repair, 1 passed, with no image writes in this project.
- `npm run test:browser -- tests/browser/stylist.spec.ts tests/browser/shell-layout.spec.ts --project=chromium --project=mobile --project=webkit-photo --workers=2 --retries=0 --grep "a manual temperature on Today is not sent while weather is turned off|WEATHER1 Today header geometry"`:
  11 passed: 2 stylist checks and 9 EN/FI/SV header checks. The existing
  WebKit project does not select `stylist.spec.ts`; no WebKit stylist pass or
  config/CI change is claimed. Fixture port 5197, no retries or captures.
- Post-repair `npm run lint`, `npm run typecheck`,
  `npm run check:translations` (1105 keys) and `git diff --check`: pass.
  Independent repair-delta review, publication and natural new-head CI
  remain pending. No additional local images were
  generated; final exact-head CI captures and coordinator review remain open.

## WEATHER2: current temperature and daytime progression (8 October 2026)

Status: **implemented locally; awaiting independent review and publication.**
Owner scope is [#84 c6059311590](https://github.com/drrowdev/stillroom-wardrobe/issues/84#issuecomment-6059311590);
the coordinator's [approval and START c6059455401](https://github.com/drrowdev/stillroom-wardrobe/issues/84#issuecomment-6059455401)
released this writer's read-only gate. Base and unchanged local HEAD:
`f6f657351e7c06e9ee9eb7c1e8d6edc43ca0a169`, branch
`drrowdev-weather2-current-temperature`. Requirements: R10 optional weather,
R09 deterministic suggestions, R17 accessibility, R27 localization; I16/S03.
The newer D21/R6 deployment evidence does not rewrite the historical release
ledger or establish this packet's deployment or acceptance.

### Behavior and boundaries

- The existing bounded forecast request also asks for
  `current=temperature_2m`. No new endpoint, provider, geolocation, persistence,
  credentials or dependency. Rounded coordinates, request privacy, two-day
  forecast, size bounds and deadline remain unchanged.
- The header shows the supplied current temperature, not the day's low or a
  nearest-hour guess: current 13 C and low 6 C remain distinct. Missing,
  malformed, future, stale, wrong-date or mismatched timezone/offset current
  is unavailable without discarding usable forecast data. Real calendar and
  DST validity are checked; the details identify a model estimate and its
  city-local valid time.
- Current validity and fetch age are each strictly less than 15 minutes.
  The current-expiry timer only clears the label; refreshes use the same
  single-flight request at a bounded 15-minute attempt/fetch interval while
  visible and online. Hidden completion is retained only for the still-owned
  city; visible return joins pending work or makes one due request.
- The three-hour/date-bound forecast and conservative low/rain/wind engine
  inputs remain usable during refresh, offline and refresh failure. Errors
  stay visible, with the existing 60-second explicit-retry cooldown; stale
  successful current data does not cause an immediate retry loop. Once the
  forecast itself expires, its recommendation inputs stop counting.
- A dependency-free semantic list presents every city-local hour 07:00-21:00
  inclusive, including elapsed morning hours. Missing points remain unknown;
  no interpolation. All missing hourly temperatures have an explicit
  unavailable state. Values/times are readable to screen readers, with
  wrapping and vertical disclosure scrolling at 320 px, 200% text and
  height 568. Manual and Indoors overrides, disclosure/focus, credit and
  owner/city/off guards remain intact. EN/FI/SV use typed keys and Intl.

### Local validation and diagnosed repairs

Pinned Node `24.19.0` / npm `11.17.0` were scoped to each command. The initial
`npm run typecheck` failed because `tsc` was absent; only then
`npm ci --ignore-scripts --no-audit --no-fund` restored locked dependencies.
Locked Playwright `1.63.0` Chromium/headless `1243` and WebKit `2359`
matched the existing cache and launched successfully. Browser runs used
reserved port 5197, two workers, zero retries and blocked external hosts;
`ALLOW_HOSTED_SMOKE` remained unset.

- `npm run lint`, `npm run typecheck`, `npm run check:translations` and
  `git diff --check`: pass. Translation check: 1131 keys in EN/FI/SV.
  Type migration explicitly supplied the new required Forecast fields;
  no optional-field workaround. A new capture-test Node/Element type
  mismatch and an incorrect test key were corrected before execution.
- `npm run test:unit -- tests/unit/weather.test.ts tests/unit/weather-chips.test.ts tests/unit/weather-zone.test.ts tests/unit/today-featured.test.ts tests/unit/recommendations.test.ts tests/unit/recommendations-properties.test.ts`:
  6 files / 78 tests passed. Coverage includes current/low separation,
  unknown/partial values, real calendar/DST/offset validity, local dates
  ahead/behind UTC, strict freshness, 07/21 endpoints and single-flight
  refresh/cooldown with retained conservative forecast.
- `npm run test:browser -- 'weather\.spec\.ts' 'today\.spec\.ts' 'shell-layout\.spec\.ts' --project=chromium --project=mobile --project=webkit-photo --workers=2 --retries=0 --grep-invert 'visual evidence|bounded synthetic captures|WEATHER1 visual|WEATHER2 visual'`:
  initial run, 363 passed / 2 existing skips / 7 failed. Filename-only
  filters selected 372 tests; all inherited weather/Today/shell captures
  were excluded without excluding the functional groups.
- The seven failures had three identified assertion causes: the expected
  request omitted the new current parameter; the idea snapshot compared
  visible innerText with hidden menu textContent; Swedish time punctuation
  came from Node Intl rather than browser Intl. The corrected test checks
  browser formatting, all expected request parameters and the unchanged
  visible idea after explicitly selecting an alternate idea.
  `npm run test:browser -- 'weather\.spec\.ts' --project=chromium --project=mobile --project=webkit-photo --workers=2 --retries=0 --grep 'header shows current temperature|current expiry, held refresh|I16 sends nothing until Search'`:
  15 passed, covering all seven failures. The full noncapture invocation
  was not repeated after these test-only corrections. The two existing
  desktop-WebKit safe-area skips are not native-device passes.
- Other passing browser coverage retains three-hour/midnight expiry,
  partial/flat/negative/zero temperatures, failed-refresh/offline retention,
  explicit retry, hidden completion/visible return, stale-success request
  bounds, city/owner/off races, manual/Indoors, portal lifetime and consumers.
  No timeouts, retries, engine skips or functional assertions were weakened.

### Bounded synthetic captures and pending gates

`npm run test:browser -- 'weather\.spec\.ts' --project=chromium --project=mobile --project=webkit-photo --workers=2 --retries=0 --grep 'WEATHER2 visual'`:
9 wide cases passed; 9 narrow cases failed before capture because the
existing phone identity helper opens More and closes weather. The test now
reopens the disclosure after identity verification and places WEATHER2 in
its own top-level group. No product or capture bound changed.

`npm run test:browser -- 'weather\.spec\.ts' --project=chromium --project=mobile --project=webkit-photo --workers=2 --retries=0 --grep 'WEATHER2 visual.*narrow' --output=test-results/weather2-narrow-repair`:
9 passed. Only the failed narrow functional scenes ran; the separate output
root retained the three successful wide captures without regenerating them.
Exactly six new screenshots were written in ignored
`test-results/weather2-visual/`: `current-hourly-{en,fi,sv}-{narrow,wide}.png`,
320x568 (mobile writes) and 1280x900 (Chromium writes), 24,693-70,405 bytes
each, all within 1 MiB. Every project ran geometry, hourly-value, zoom,
accessibility and privacy assertions; WebKit wrote no image. The writer
inspected filename/size metadata only, never image contents. These are local
unpublished product-source evidence, not final published-head visual approval.

The 17 inherited WEATHER1/I16 captures remain CI-owned and unexpanded;
unrelated Today/shell captures did not run locally. Coordinator-owned
Opus 5.5/high review, required exact-head CI, actual final-head artifact
review, real provider/owner/device trials and owner-run Pages deployment
remain pending. Historical unexplained stalls and the exact WEATHER1
height-900 failure cause remain unresolved, not repaired by this packet.
No local full browser, integration/security, hosted smoke, build,
secret/dependency scan, commit, push, PR publication, merge or deployment is
claimed. Rollback is the packet's source changes; no database rollback or
data mutation is involved.

### Independent-review scheduling amendment (8 October 2026)

The coordinator's one full Opus 5.5/high review returned **AMEND**: a fixed
fetch-plus-15-minute refresh left current systematically unavailable between
its quarter-hour validity expiry and the next fetch (opening at 11:14 could
show current for one minute, then unavailable for fourteen). No other
significant findings were reported. The coordinator approved this bounded
same-writer repair in
[#84 c6060148228](https://github.com/drrowdev/stillroom-wardrobe/issues/84#issuecomment-6060148228).
Only `use-weather.ts`, the existing weather unit/browser tests and this
result document changed for the amendment. Publication remains held.

- A usable current success now schedules its normal request at the later
  of strict current expiry plus 60 seconds and the previous attempt plus
  60 seconds. The grace delays only the request, **never the current label**:
  age must still be strictly under 15 minutes, nonfuture, on the correct
  real city-local date with the validated timezone/offset.
- Missing, malformed, stale or future current success instead waits
  15 minutes after fetch/latest attempt. A pending newer attempt or failed
  refresh supersedes the old observation deadline; failure waits 15 minutes
  after attempt/failure completion before another normal request. Explicit
  retry retains its 60-second failure cooldown and attempt history.
  Single-flight, hidden/offline suppression, city/owner guards and earliest
  midnight/three-hour forecast expiry remain unchanged.
- Gradual clock coverage starts at 11:14, observes unavailable at 11:15,
  current again after the 11:16 request, and repeats around 11:30/11:31
  and 11:45/11:46. It retains low 4 C, coat requirements and an explicitly
  selected alternate idea through current-only updates. Separate gradual
  failure and missing/malformed/stale/future-success cases assert exactly
  four requests through 33 minutes, not repeated minute-by-minute retries.
  The earlier `fastForward('02:59:00')` test runs each timer at most once;
  its request count proves retained three-hour expiry behavior, **not**
  recurring failure cadence. The new gradual checks supply that evidence.

Exact amendment checks (pinned tooling, port 5197, three projects, at most
two workers, zero retries, no captures or hosted access):

- `npm run lint`, `npm run typecheck`, `npm run check:translations`
  (1131 EN/FI/SV keys), `git diff --check`: pass.
- `npm run test:unit -- tests/unit/weather.test.ts tests/unit/weather-chips.test.ts tests/unit/weather-zone.test.ts tests/unit/today-featured.test.ts tests/unit/recommendations.test.ts tests/unit/recommendations-properties.test.ts`:
  6 files / 79 tests passed.
- `npm run test:browser -- 'weather\.spec\.ts' --project=chromium --project=mobile --project=webkit-photo --workers=2 --retries=0 --grep 'WEATHER2.*(late-quarter cadence|gradual failure cadence|partial-current cadence|current expiry|failed refresh|hidden completion|partial temperatures|header shows)|I16 a forecast stops counting|I16 a held forecast|going offline before|I16 a failed forecast' --output=test-results/weather2-scheduling`:
  42 passed / 18 new gradual-test failures. The existing concrete current,
  visibility, city/owner, offline, cooldown and forecast-expiry checks passed.
  One-minute `runFor` steps let the unchanged five-second provider deadline
  run before asynchronous mock responses settled; they were not valid
  successful-response cadence evidence.
- The gradual fixture now advances in one-second increments and waits for
  each observed request's terminal event before more clock advancement.
  No deadline, timeout, assertion, retry or product freshness was relaxed.
  `npm run test:browser -- 'weather\.spec\.ts' --project=chromium --project=mobile --project=webkit-photo --workers=2 --retries=0 --grep 'WEATHER2.*(late-quarter cadence|gradual failure cadence|partial-current cadence)' --output=test-results/weather2-scheduling-gradual`:
  16 passed / 2 failure-cadence fixture failures. Chromium reports the
  intentional cancellation of a rejected 503 body as `requestfailed`,
  whereas WebKit's observed path reported `requestfinished`; the terminal
  counter now observes both mutually exclusive events.
- `npm run test:browser -- 'weather\.spec\.ts' --project=chromium --project=mobile --project=webkit-photo --workers=2 --retries=0 --grep 'WEATHER2 gradual failure cadence' --output=test-results/weather2-scheduling-failure`:
  3 passed, covering the remaining two failures. No whole 372-test rerun,
  new images, inherited capture execution, commit, push or PR occurred.

The six prior local captures predate this scheduling repair and are not its
final-head visual evidence. Coordinator-owned quick Opus delta review,
publication permission, all required exact-head CI and actual final-head
capture review remain mandatory; the broader owner/device/provider and
deployment gates above remain open.

### Quick-delta pending-request closure (8 October 2026; blocked evidence)

The coordinator's quick Opus delta found one medium race: `load()` returned
the existing pending promise before clearing the explicit manual-retry flag.
Clicking Try again while the next automatic refresh was held could leave that
flag after either success or failure, overriding the normal refresh deadline.
The coordinator explicitly approved and sent START for this scoped closure.
The flag now clears before the same-key pending early return; single-flight
deduplication and attempt history are otherwise unchanged.

Two focused unit cases (200 and 503) assert the same pending promise, exactly
one fetch, cleared explicit schedule, and correct observation-expiry/failure
fallback deadlines. `npm run test:unit -- tests/unit/weather.test.ts`:
25 tests passed. `npm run lint`, `npm run typecheck`,
`npm run check:translations` (1131 keys) and `git diff --check`: pass.

The bounded browser cases reproduce a failed refresh followed by a held
automatic request, click the still-available retry, settle either 200 or 503,
and require one pending request and the normal later cadence without a
60-second dispatch or a stall.

- `npm run test:browser -- 'weather\.spec\.ts' --project=chromium --project=mobile --project=webkit-photo --workers=2 --retries=0 --grep 'WEATHER2 held refresh retry' --output=test-results/weather2-held-retry`:
  6 failed before reaching the held request. The fixed clock advance stopped
  before failure completion plus 15 minutes plus the timer's 50 ms margin.
- The same command with `--output=test-results/weather2-held-retry-boundary`
  after advancing one additional second: 4 passed (Chromium/mobile, both
  statuses), 2 failed (WebKit, held request still absent).
- The gradual fixture additionally waits for the visible disabled retry
  control after a rejected request's terminal event, so network completion
  alone does not stand in for recorded failure state. The same command with
  `--output=test-results/weather2-held-retry-settled`: 4 passed, the same
  2 WebKit failures before the held request.

The remaining WebKit dispatch-boundary cause is **unresolved**. The proposed
render-settlement explanation did not resolve it; this is not an all-project
passing closure. No assertion, timeout, deadline or retry was weakened.
Browser execution stopped and the blocker was sent to the coordinator before
any further budget. Only the approved four repair paths changed; no images,
whole-suite rerun, commit, push, PR, hosted operation or deployment occurred.
Publication remains held pending a bounded diagnostic decision and the
previously required coordinator verification/exact-head gates.

### Observed-boundary closure (8 October 2026)

The coordinator authorized one numeric/text-only WebKit diagnostic of the
200 case, preserving all assertions and deadlines:
`npm run test:browser -- 'weather\.spec\.ts' --project=webkit-photo --workers=1 --retries=0 --grep 'WEATHER2 held refresh retry joins one request and restores normal cadence after 200' --output=test-results/weather2-held-webkit-diagnostic`.
It failed before Try again/held dispatch. The paused fake clock was 11:14:10;
the failed request's start and terminal event were observed during the
11:16:04 one-second step (step-clock upper bound, not a falsely exact
page-event timestamp). Before/after the 52-second jump, actual fake Date.now
was 11:30:10 / 11:31:02, with visible/online true, retry enabled, error present
and request/completed/held counts 2/2/0. The fixed test endpoint preceded the
observed failure plus its 15-minute fallback, approximately 11:31:03-04.
No third request started or failed during the jump. All temporary probes
were removed and diff-check passed. The source of the few-second initial
dispatch offset remains unknown; no environment or product attribution is
made.

The coordinator then approved a test-only derived-boundary correction.
The gradual helper returns the fake clock after the rejected request's
terminal event and visible disabled retry state have settled, giving a
one-second completion upper bound. The held test derives the next due
boundary from this observation plus 15 minutes and the existing 50 ms timer
margin. It advances in bounded one-second steps only until that boundary,
stopping as soon as the held route is observed so the five-second provider
deadline is not crossed. No arbitrary longer jump, wait, timeout, clock
skew allowance or product change was introduced.

`npm run test:browser -- 'weather\.spec\.ts' --project=chromium --project=mobile --project=webkit-photo --workers=2 --retries=0 --grep 'WEATHER2 held refresh retry' --output=test-results/weather2-held-derived-boundary`:
**6 passed**, once after this correction. Both 200/503 outcomes in every
project retain exactly one held request when Try again joins it, then restore
the correct normal cadence without a 60-second dispatch or a stall.
The earlier failure chronology remains evidence, not a passing run.
`npm run lint`, `npm run typecheck`, `npm run check:translations` (1131 keys),
`npm run test:unit -- tests/unit/weather.test.ts` (25 tests) and
`git diff --check`: pass after the correction.

The held-case local blocker is closed; coordinator closure verification and
publication instruction remain pending, along with exact-head CI and visual
acceptance. No new images, whole-suite rerun or publication occurred.

## RAIN1: Stylist weather applies only to outerwear (9 October 2026)

Source-only change following the owner decision in #84. Weather (temperature bounds, rain, wind) influences only `outerwear` garments in the Stylist; other categories are never excluded or ranked by it, and their weather-only fields are not sent. New manifest `azure-eu-terra-stylist-v2` and migration `20261009090000_stylist_weather_outerwear.sql` (the v1 migration and its pinned hashes are unchanged); the claim accepts v1 and v2, the new source requires v2.

Not done and not claimed: hosted migration, switching owner controls to v2, Edge function or client deploy, activation, and any paid model-quality trial (owner-approved external gate). Integration, Edge, rehearsal and full CI suites were not run locally.

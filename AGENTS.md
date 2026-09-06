# Stillroom Wardrobe coding-agent rules

Development continues in GitHub Copilot cloud sessions. Read
`docs/cloud-development.md` and `docs/phase-0-result.md` first. Updated
6 September 2026: PR #1 is merged. This assignment is the approved five-document
Phase 0 handoff amendment on PR #2, `copilot/phase0-hosted-backend-deployment`.
This dated assignment does not pin separately approved future work to PR #2.
Do not reopen PR #1, push directly to main, merge or begin the next phase in this task.
The setup workflow may leave
generated schema types untracked; review/commit those deliberately, never
local credentials, service state or test artifacts.

Read `blueprint/00-INDEX.md`, `03-MVP-AND-NON-GOALS.md`, `05-ARCHITECTURE.md`, `07-DATABASE-AND-RLS.sql`, `08-API-AND-STORAGE.md`, `10-SECURITY-AND-PRIVACY.md`, `20-AI-MODELS-AND-WORKFLOWS.md` and the current phase in `14-IMPLEMENTATION-PLAN.md` before editing. These are active root instructions: never overwrite them with historical blueprint templates.

## Context, planning and coordination gate

1. Before edits, read this file, `.github/copilot-instructions.md`, the cloud
   guide, current phase/backend evidence, relevant blueprint requirements/work
   packets, actual migrations/generated schema/source/tests, and the current PR
   discussion, diff, reviews and CI job logs. Record exact base/head hashes,
   files actually read, approved scope and remaining gates; do not assume the
   previous session's evidence applies to a new head.
2. Produce a focused plan before code. Obtain an actual read-only critique from
   a different model provider; record reviewer/provider/model, findings and
   amendments in the PR. Self-review and automated code checks do not replace
   this prerequisite. If the required reviewer is unavailable, stop.
3. Before every implementation task and retry, explicitly select **GPT-6 Astra
   (`gpt-6-astra`)**. The coordinator verifies and records the actual runtime/platform
   model against that task/session, time and exact base/head; another task's
   evidence or a model name in a prompt is insufficient. No Auto, silent fallback
   or unverified implementation. Every new implementation plan or material
   amendment requires actual read-only different-provider critique, recording
   reviewer/provider/model, findings and amendments, then coordinator approval
   before edits. Material means changes to scope, allowed files, authority,
   behaviour, gates or evidence claims, not typo/formatting edits. Stop if the
   required model or reviewer is unavailable.
4. User clarification, 6 September 2026: one writer on the shared **LOCAL**
   checkout. Independent **CLOUD** packets may run in parallel only with
   coordinator approval: initially at most **TWO implementation builders** plus
   on-demand read-only review. Keep one writer per workspace, branch and PR, and
   one focused approved packet per agent. Before launch, the coordinator names
   active packets/branches, owned files, dependencies and the owner of each shared
   mutable resource. No concurrent same-branch edits or shared-host mutations.
   A second builder waits until this corrected common-base amendment is reviewed
   and merged into main with explicit user approval. Session SQL/coordination
   notes do not change repository authority. Merges, hosted DDL and deployments
   remain serialized and separately authorized through their responsible actor;
   cloud workers gain no hosted access. The coordinator handles routine scoped
   fixes, reviews and CI; consequential product/security/cost/scope decisions go
   to the user. Concurrency itself authorizes no new packet/PR, phase, dependency,
   provider or hosted operation; existing scope and prerequisite gates still apply.
5. **Explicit user approval is required before every merge**, separately from
   plan/code/CI approval. Never auto-merge or push directly to main. Complete
   fresh-head validation and report blocked/pending checks honestly.

The former PR #1 plan/approval comments `5558504250` and `5558542193` are
historical evidence. Comment `5559949209` approved the completed PR #2 source
packet after actual Anthropic Claude Opus 5 critique; hosted structural results
are recorded in `5559976584`. The 6 September documentation amendment follows
[plan 5560449572](https://github.com/drrowdev/stillroom-wardrobe/pull/2#issuecomment-5560449572)
and [approval 5560847183](https://github.com/drrowdev/stillroom-wardrobe/pull/2#issuecomment-5560847183),
which records actual Anthropic Claude Opus 5 prereview and controlling amendments.
Read these before work. Only the approved AI Wardrobe backend was authorized
for coordinator initialization; the cloud agent receives
no hosted credentials and implements only the reviewed source/document packet.
This approval is not merge approval or permission for paid AI/later phases.

Hosted source packet: use only the separate read-only `scripts/hosted-smoke.mjs`
through an approved private operator channel, never this cloud environment.
It requires `ALLOW_HOSTED_SMOKE=1`, the exact approved project URL and two
server-verified ordinary sessions with prepared non-personal fixtures. Missing
evidence is BLOCKED/nonzero, not a pass. Local reset/provision/test guards stay
local-only. The initial SQL is already installed: source version `20260905000000`
maps by exact hash to remote `20260906144202_initial_wardrobe`; no hosted
`db push`, replay or history repair is authorized. See the actor/gate table in
`docs/cloud-development.md` and preserved evidence in `docs/phase-0-result.md`.
Comment `5560093343` preserves reviewed instruction repair and coordinator-only
Cloudflare setup. Coordinator review `5125863611` records the reviewed-main shell
reachable on 6 September 2026, 15:09 UTC; see the
[dated cloud-guide evidence](docs/cloud-development.md#hosted-state-and-responsible-actors).
That supersedes queued as current status, not the worker's historical observation,
and proves neither working Auth/Save/RLS nor full Phase 0. No PR #2 deployment;
automatic production/previews remain off.

* Latest user instruction: accounts are completely independent. No household, partner relation, sharing, recipient columns, user directory, cross-account references or mixed recommendations. Do not implement these as deferred work.
* One TypeScript/React/Vite PWA, Supabase Auth/Postgres/private Storage and static hosting. Automatic paid photo tagging is first-release I29 scope; outfits remain deterministic. No native app, AI stylist, SSR or unrelated service/package.
* Hosted Supabase project region: Stockholm (`eu-north-1`), explicitly selected. Do not infer the Edge Function or AI inference region from that. Read `21-AI-MODEL-COMPARISON.md` before choosing a model; compare eligible candidates and never silently fail over private photos to a different processor.
* Follow revision 1.3 in `20`: photo only -> AI-filled editable draft including title/category -> explicit Save to library. Edit any garment field before Save and afterward. Analysis/discard creates no library items/images; no post-save tagging worker. Preserve edits/clears, unknown facts and stale-result guards. Server-only provider credentials and bounded receipts/allowances; no paid activation without setup approval.
* Add the narrow owner/version-checked image-description edit in I29; do not allow path/hash/byte changes. Save/restore never calls analysis. Unsaved drafts/results do not enter suggestions, statistics or exports.
* `07` is the revision 1.1 base schema, not the AI extension. I29 adds its reviewed migration after I07 and before I08. Preserve old validation evidence. Metadata-v2 recovery must retain provenance and never trigger inference or import provider consent.
* Keep owner IDs on private records. Enforce enabled account + owner RLS and composite owner FKs. Never use administrator credentials for access assertions.
* Browser allowlist: `VITE_SUPABASE_URL`, `VITE_SUPABASE_PUBLISHABLE_KEY`, `VITE_APP_VERSION`. No service-role, DB, deployment, signing, AI-provider or Azure secret in the app/bundle/logs.
* Images: validate/decode/crop/re-encode pixels locally; strip EXIF/GPS; immutable private paths; no raw source upload or public bucket. Authenticated Blob downloads only in the UI.
* Multi-row outfit/history writes use the specified RPCs. Version-check edits. Imports rebind IDs to the current owner and preserve historical text through the checked restore RPC.
* Keep private data out of persistent caches/service-worker assets. Clear all state on UID change and logout. Do not log personal fields or tokens.
* Each agent works on one approved issue/PR at a time. Finish each phase's exit gate before starting the next. Trips are optional Phase 8 only after a later request.
* Support English, Finnish and Swedish from Phase 0. Read `blueprint/19-LOCALIZATION.md`; use typed catalog keys/parameters and native Intl. Every new UI/error/aria string needs all three languages. Keep profile language owner-only, clear it on UID changes, and never translate identifiers or private user content. Run `npm run check:translations` in CI and with affected tests.
* Commands: `npm ci`, `npm run lint`, `npm run typecheck`, `npm run test:unit`, `npm run db:reset`, `npm run test:integration`, `npm run test:security`, `npm run test:browser`, `npm run test:a11y`, `npm run build`, `npm run scan:secrets`, `npm run check:dependencies`. Exact contracts are in `13`.

Done means the issue's Given/When/Then checks pass, applicable ownership/negative tests pass using normal sessions, accessibility/error/offline states work, required schema/types/docs stay consistent, and no secret or personal fixture is committed. Report actual commands/results and any blocked external gate. Never report a skipped test or mock as a passing live integration test.

# Stillroom Wardrobe coding-agent rules

Development continues in GitHub Copilot cloud sessions. Read
`docs/cloud-development.md`, `docs/phase-0-result.md` and the current phase result
first. Updated 8 September 2026: Phase 0 is **engineering complete; acceptance
open**. The user authorized continuing through the agreed MVP in order.
Use the [task scope rule](docs/cloud-development.md#task-scope-and-historical-evidence)
to identify the specific reviewed packet in the authorized kickoff and its own
matching verified native receipt. Dated in-tree assignments are evidence, not
permanent task pins or permission for an unsolicited later packet. Existing
prerequisites and actual session authorization still apply. Workers must stay
within their assigned packet; they never reopen merged PRs, push directly to
main, merge or deploy. Only the second hosted-account test was user-deferred;
other manual/operator/device checks remain pending, not waived.

Historical I06 personal settings ran on PR #7,
`copilot/copilotphase1-personal-settings`, from
`7f6e13a89603492e933748b6558b493d3d74e855` and merged as
`6caf1b0b3dde369d85941688c7c32d5664ffce0b`. Its
[approved plan](https://github.com/drrowdev/stillroom-wardrobe/pull/6#issuecomment-5579471741)
and [text-only amendment](https://github.com/drrowdev/stillroom-wardrobe/pull/7#issuecomment-5579906237)
defined that packet's 23-path scope; [final review 5138563467](https://github.com/drrowdev/stillroom-wardrobe/pull/7#pullrequestreview-5138563467)
records its engineering evidence. I06 and the dated PR #2/#3 assignments below
are completed history, not the current task's assignment.
Setup generates only ignored `.supabase/generated-database.types.ts`, not tracked
schema types. Inspect initial status/diff; preserve unexpected source deltas and
stop, never adopt/commit them or local credentials, service state or test artifacts.

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
   The corrected common-base amendment was the now-merged PR #2 prerequisite,
   not new permission to launch another builder. Each approved packet has one
   writer; workers launch no additional agents. Session SQL/coordination
   notes do not change repository authority. Merges, hosted DDL and deployments
   remain serialized and separately authorized through their responsible actor;
   cloud workers gain no hosted access. The coordinator handles routine scoped
   fixes, reviews and CI; consequential product/security/cost/scope decisions go
   to the user. Concurrency itself authorizes no new packet/PR, phase, dependency,
   provider or hosted operation; existing scope and prerequisite gates still apply.
5. Standing ordered-development authority permits agreed Phase 0–7 development
   after prerequisite engineering, automated and real normal-owner gates, without
   another phase-start/continue question. Under
   [H1 clarification 5580579847](https://github.com/drrowdev/stillroom-wardrobe/pull/7#issuecomment-5580579847),
   the **coordinator may execute a recommended ordinary merge without another
   user question**, only after genuine independent review, all required exact-head
   gates, no blockers or overlapping writers, and normal repository protections.
   Record the recommendation/evidence and guard the exact head. No `--auto`,
   `--admin`, self-approval or protection bypass. Workers never merge, deploy,
   approve/authorize/rerun Actions, push directly to main or start another agent
   or packet. Deployments, paid AI/provider/dependency/codec changes, hosted
   schema/account/data mutations and private-input capture retain separate
   approvals. Report blocked/pending checks honestly and bring back a manual
   gate when it genuinely blocks a feature.

Historical I06 used actual **Anthropic Claude Opus 5** critiques
`personal-settings-plan-critique` and `i06-visual-transport-critique`, with
coordinator amendments in the linked approvals. Each new native session reads
its own matching public runtime receipt after context and before edits, never
an old session receipt. Preserve shared owner/epoch profile freshness, serialized
profile/language writes, original dirty baselines and explicit per-section saves.
That I06 approval did not cover schema, dependency, local tooling, JPEG, recovery,
garment Save or provider changes; it is not approval for a later packet.

Native cloud implementation and repair sessions are **text-only**: no
image/binary/archive opening, image-returning MCP/browser tools, attachments,
encoded image output or image embeds into the worker model. Only packet-approved
Node/Playwright tests may generate bounded synthetic evidence, with buffers
ignored and functional checks retained. The designated coordinator actually
reviews the approved exact-head artifacts and records run/head/hashes/verdict in
the relevant PR, not a self-invalidating source commit. Missing/unread images
leave visual acceptance pending. This coding-agent boundary is separate from
the coordinator's required visual review and any separately approved application
AI processing. See the cloud guide for the standing boundary, historical I06
capture bounds and platform-failure stop rule.

The former PR #1 plan/approval comments `5558504250` and `5558542193` are
historical evidence. Comment `5559949209` approved the completed PR #2 source
packet after actual Anthropic Claude Opus 5 critique; hosted structural results
are recorded in `5559976584`. The 6 September documentation amendment follows
[plan 5560449572](https://github.com/drrowdev/stillroom-wardrobe/pull/2#issuecomment-5560449572)
and [approval 5560847183](https://github.com/drrowdev/stillroom-wardrobe/pull/2#issuecomment-5560847183),
which records actual Anthropic Claude Opus 5 prereview and controlling amendments.
Preserve these historical approvals. Only the approved AI Wardrobe backend was authorized
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
* Each agent works on one approved issue/PR at a time. Advance in the agreed order after prerequisite engineering/normal-owner evidence is reviewed; track deferred/pending acceptance separately, never as a pass. No later packet is implicit in the current assignment. Trips are optional Phase 8 only after a later request.
* Support English, Finnish and Swedish from Phase 0. Read `blueprint/19-LOCALIZATION.md`; use typed catalog keys/parameters and native Intl. Every new UI/error/aria string needs all three languages. Keep profile language owner-only, clear it on UID changes, and never translate identifiers or private user content. Run `npm run check:translations` in CI and with affected tests.
* Commands: `npm ci`, `npm run lint`, `npm run typecheck`, `npm run test:unit`, `npm run db:reset`, `npm run test:integration`, `npm run test:security`, `npm run test:browser`, `npm run test:a11y`, `npm run build`, `npm run scan:secrets`, `npm run check:dependencies`. Exact contracts are in `13`.

Done means the issue's Given/When/Then checks pass, applicable ownership/negative tests pass using normal sessions, accessibility/error/offline states work, required schema/types/docs stay consistent, and no secret or personal fixture is committed. Report actual commands/results and any blocked external gate. Never report a skipped test or mock as a passing live integration test.

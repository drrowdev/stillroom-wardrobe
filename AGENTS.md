# Stillroom Wardrobe coding-agent rules

Development continues in GitHub Copilot cloud sessions. Read
`docs/cloud-development.md` and `docs/phase-0-result.md` first. Updated
6 September 2026: PR #1 is merged. The current user-approved packet is Phase 0
hosted readiness on PR #2, `copilot/phase0-hosted-backend-deployment`.
Do not reopen PR #1, push directly to main, merge or begin the next phase.
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
3. The coordinator approves the amended plan and explicitly selects **GPT-6
   Astra (`gpt-6-astra`)** for implementation, verifying the actual model from
   runtime/platform evidence. A model name in a prompt is not verification.
   No Auto, silent fallback or unverified model claim; stop if unavailable.
   Material scope changes require renewed different-provider critique and
   coordinator approval before implementation.
4. One implementation writer at a time. The coordinator handles routine
   in-scope findings/fixes; consequential product, security, cost or scope
   decisions go to the user. Do not launch parallel writers or expand phases.
5. **Explicit user approval is required before every merge**, separately from
   plan/code/CI approval. Never auto-merge or push directly to main. Complete
   fresh-head validation and report blocked/pending checks honestly.

The former PR #1 plan/approval comments `5558504250` and `5558542193` are
historical evidence. The current PR #2 packet is approved in comment
`5559949209`, after actual Anthropic Claude Opus 5 critique; hosted structural
results are recorded in `5559976584`. Read these before work. The coordinator
may initialize only the approved AI Wardrobe backend; the cloud agent receives
no hosted credentials and implements only the reviewed source/document packet.
This approval is not merge approval or permission for paid AI/later phases.

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
* Work on one issue/PR at a time. Finish each phase's exit gate before starting the next. Trips are optional Phase 8 only after a later request.
* Support English, Finnish and Swedish from Phase 0. Read `blueprint/19-LOCALIZATION.md`; use typed catalog keys/parameters and native Intl. Every new UI/error/aria string needs all three languages. Keep profile language owner-only, clear it on UID changes, and never translate identifiers or private user content. Run `npm run check:translations` in CI and with affected tests.
* Commands: `npm ci`, `npm run lint`, `npm run typecheck`, `npm run test:unit`, `npm run db:reset`, `npm run test:integration`, `npm run test:security`, `npm run test:browser`, `npm run test:a11y`, `npm run build`, `npm run scan:secrets`, `npm run check:dependencies`. Exact contracts are in `13`.

Done means the issue's Given/When/Then checks pass, applicable ownership/negative tests pass using normal sessions, accessibility/error/offline states work, required schema/types/docs stay consistent, and no secret or personal fixture is committed. Report actual commands/results and any blocked external gate. Never report a skipped test or mock as a passing live integration test.

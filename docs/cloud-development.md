# GitHub Copilot cloud development

Development continues in GitHub-hosted Copilot sessions against
`drrowdev/stillroom-wardrobe`. Source is public; account credentials, photos,
backups and local service state must never be published.

## Prepared environment

`.github/workflows/copilot-setup-steps.yml` contains the required single
`copilot-setup-steps` job on a standard Ubuntu runner. It installs pinned Node 24,
locked npm dependencies and Chromium, then starts disposable local Supabase,
applies the exact base migration, provisions fictional accounts and generates
real database types. Docker images are downloaded during setup, before the
agent's normal network restrictions take effect.

No production Supabase access, paid AI endpoint, larger runner, firewall
disablement or user-supplied production secret is required by cloud setup.
The separately approved hosted project is in Stockholm (`eu-north-1`).

Setup failures are not passes: Copilot may still start in a partially prepared
environment. First inspect its setup log and `git status`, then confirm the
local stack with `npm run db:start` rather than assuming services survived.
Do not reset a useful in-progress fixture unless recovery requires it.

The generated `src/data/database.types.ts` can initially be untracked. Review
and commit it deliberately; never sweep `.env.local`, `.supabase`, browser
state, test results or logs into a commit. These are ignored. The test wrapper
passes ordinary fictional credentials to its child processes and strips
privileged/GitHub credentials.

## Active cloud task: Phase 0 hosted readiness on PR #2

Updated 6 September 2026: PR #1 was merged with the user's approval at
`f696ee45e5dfe46be90cbc295a9811ec1d34a298`. The user subsequently requested
autonomous continuation toward the complete app and authorized the dedicated
Stockholm backend. Continue the reviewed source/document packet on PR #2,
`copilot/phase0-hosted-backend-deployment`, under plan approval comment
`5559949209` after actual Anthropic Claude Opus 5 critique.

The coordinator installed the exact reviewed base SQL in the approved project;
comment `5559976584` records the migration/hash and structural observations.
The cloud agent does not receive hosted credentials or run hosted writes.
Hosted Auth configuration, private owner admission, website deployment,
ordinary-session hosted smoke and physical-device checks are separate gates.
No paid app AI, later phase or merge is authorized. Cloudflare access is now
connected to the coordinator, not inherited by the cloud worker.

### Hosted state and responsible actors

These are coordinator-reported facts from comments `5559976584` and
`5560093343`, not hosted operations or independently observed cloud-worker
results. The dedicated **AI Wardrobe** project is `xwrdrugastphdiihzuia`,
organization `murdxzxflzlbyrnpwbqg`, Stockholm `eu-north-1`.

The coordinator applied `supabase/migrations/20260905000000_initial.sql`
**once**, after fresh empty-target/privilege/hash checks, through the private
SupabaseProton connection. Exact source: **35214 bytes**, SHA-256
`4f2d44603707cb823527c80d8384c2a6390f99ead2ba294435db83403a7eead5`.
Stored remote SQL matches, but the remote migration is
`20260906144202_initial_wardrobe`, not source version `20260905000000`.
**Do not run hosted `db push`, replay, reset or automatic history repair.**
Any future CLI history reconciliation needs a separately reviewed operator step.

Structural checks reported 12 RLS-enabled application tables; private
JPEG-only `wardrobe` bucket with 512000-byte limit; three owner Storage
INSERT/SELECT/DELETE policies and no UPDATE; three Auth admission/email
triggers; zero admissions and zero Auth users at installation. Advisors reported
two informational deny-all private tables and four authenticated checked
SECURITY DEFINER image/restore warnings. Preserve these observations; do not
broaden permissions to silence them. Administrator structural/advisor checks
are **not ordinary-session hosted RLS proof**.

| Gate | Current evidence / next step | Responsible actor |
|---|---|---|
| Backend installation | Exact base SQL installed once; mapping above preserved. No I29 extension or AI activation. | Coordinator/operator; cloud source worker must not access it |
| Hosted Auth | Unconfirmed. Use dashboard/supported management API to verify global signup and anonymous disabled, email/password provider enabled, phone/OAuth disabled, Site URL `https://stillroom-wardrobe.pages.dev` and only exact necessary redirect URLs (no arbitrary previews/wildcards). Record actual settings, not local TOML/SQL inference. | Coordinator/operator |
| Intended owners | Actual identities not privately supplied; no permanent fictional slots. Verify each intended owner privately, admit/create independently through the approved operator process, deliver only that person's credential and confirm password access privately. Never use local reserve/provision scripts on hosted. Password/account/recovery setup is outside the smoke runner. | User supplies inputs privately; coordinator/operator handles approved setup |
| Website | Git-backed Pages project `stillroom-wardrobe` created; selected GitHub repo access verified. Automatic production deployments OFF, preview deployments NONE, no production backend in preview environment. | Coordinator through official Cloudflare connection only |
| Live deployment | Manual deployment `91462a90-2f8c-40bf-a828-6a800ce19f33` builds only reviewed CI-green main `f696ee45e5dfe46be90cbc295a9811ec1d34a298`; queued at last observation. Verify success, HTTPS/assets/headers at `https://stillroom-wardrobe.pages.dev` separately. No PR #2 deployment. | Coordinator |
| Hosted smoke | BLOCKED until both intended ordinary sessions and prepared non-personal item/main/thumb fixtures exist. Run the separate read-only command below privately and report only coarse result plus reviewed code head. | Approved private operator, not cloud agent or public CI |
| Phone/accessibility | Actual iPhone/Safari and Android camera/library, rotation/compatible-photo fallback, explicit Save/Discard, own login/logout, EN/FI/SV, VoiceOver/TalkBack and narrow/zoomed layout checks remain open. Emulation/axe is insufficient. | Human owners/testers |
| Code/merge | Fresh-head App/browser and Real local Supabase CI including actual types parity; coordinator's independent read-only Claude review; explicit user approval before every merge. | Cloud worker reports code checks; coordinator reviews; user approves merge |

Pages production configuration contains only public `VITE_SUPABASE_URL`,
`VITE_SUPABASE_PUBLISHABLE_KEY`, `VITE_APP_VERSION` and build-only
`NODE_VERSION=24.19.0`. No administrator secret, Functions/bindings, paid hosting
or automatic deployment workflow. Other sites, DNS and billing are untouched.
A reachable shell does not prove login, owner setup, Storage/RLS or full Phase 0.

### Private read-only hosted smoke

Run `node scripts/hosted-smoke.mjs` only in an approved private operator process
with a **clean environment**, populated through private process/credential
tooling. Do not paste values into commands, shell history, this repository,
GitHub secrets/environments, comments, screenshots or logs. No dotenv loading,
credential file reads, CLI arguments, password login, refresh, email/OTP/recovery,
signing, mutation, provisioning or remote cleanup occurs. Existing operator
sessions remain untouched. Expired sessions require fresh private operator input.

Required environment names (values must never be published):

* `ALLOW_HOSTED_SMOKE=1`
* `HOSTED_SUPABASE_URL` exactly `https://xwrdrugastphdiihzuia.supabase.co`
* `HOSTED_SUPABASE_PUBLISHABLE_KEY`: modern public `sb_publishable_` key,
  not a legacy JWT or service key
* For each diagnostic label `A` and `B`: `HOSTED_A_USER_ID`,
  `HOSTED_A_ACCESS_TOKEN`, `HOSTED_A_ITEM_ID`, `HOSTED_A_IMAGE_ID`, and the
  corresponding `HOSTED_B_*` names. These are runtime expected identities and
  pre-existing sample IDs, not permanent owner slots or account relationships.

Only those inputs and optional `PATH`, `SystemRoot`, `SYSTEMROOT`, `WINDIR`,
`HOME`, `USERPROFILE`, `LANG`, `LC_ALL`, `TMPDIR`, `TMP`, `TEMP` are accepted.
All other inherited variable names, including empty GitHub/service/DB/cloud
credential entries, proxy overrides and `NODE_OPTIONS`, cause refusal. The
operator must launch a clean process, not pass a copy of their ordinary shell.

Before data checks, `GET /auth/v1/user` must confirm each intended UID and
ordinary non-anonymous authenticated identity; decoded JWT claims alone never
establish identity. All requests are GET, no-store, timeout/size-bounded, and
refuse redirects. Both owners must read their own profile, specified live item,
ready image metadata and matching main/thumbnail bytes. Both foreign directions
then require empty row reads and explicit Storage not-found denial for those
known-existing paths. Finally repeat server identity and all own positives,
including unchanged projected metadata and byte hashes.

Exit **0 / PASS** means only those read-only checks completed, not the full
mutation/admission/access matrix or phone acceptance. Exit **1 / FAIL** means
foreign rows/media were exposed. Exit **2 / BLOCKED** means incomplete inputs,
identity/positive-fixture failure, outage, unexpected denial format, changed
fixture, missing liveness or unavailable evidence. Unexpected responses never
count as denial; cancellation cannot turn a primary failure into success.
Output contains only the coarse result. Unit mocks prove runner contracts,
not hosted RLS. No live hosted invocation was performed in this cloud packet.

## Historical foundation and PR #1 continuation

The initial push is **work in progress**, not a completed Phase 0 release.
Read `docs/phase-0-result.md`, the root agent instructions and the blueprint.

The original cross-tab/landmark/contrast defects and temporary type projection
were repaired before the continuation baseline
`f20c745eec9084cc900770cb2b206100ad94b784` (base
`d20457a82bca6e8d505d20b38dc07b4c930900cd`). Standard
[CI 34025264676 attempt 2](https://github.com/drrowdev/stillroom-wardrobe/actions/runs/34025264676)
passed on that head: App/browser job `101466868103` (40 cases), real local
Supabase job `101466868242` (start/reset, ordinary integration/security, actual
type generation and tracked-file/diff parity). Earlier sandbox workarounds are
historical, not a current failed CI gate; retain them in the result document.

The completed PR #1 continuation followed [plan comment 5558504250](https://github.com/drrowdev/stillroom-wardrobe/pull/1#issuecomment-5558504250)
and [approval/amendments 5558542193](https://github.com/drrowdev/stillroom-wardrobe/pull/1#issuecomment-5558542193):
different-owner SDK broadcast regressions, bounded exact-token correction,
unapproved email admission checks, accurate provider/evidence documentation,
and persistent coordination rules. That historical packet did not authorize
schema, Auth configuration values, setup workflow or phase expansion. Its
baseline success is not transferable evidence or merge approval for PR #2.

Prepared setup in agent run `34026811034`, job `101469132212`, completed the
locked install, Chromium, standard local start/reset/provision and actual type
generation successfully on 6 September 2026. No standalone setup rerun or
manual container workaround is needed for that successful preparation.

```sh
npm run db:start
ALLOW_SECURITY_TESTS=1 npm run test:integration
ALLOW_SECURITY_TESTS=1 npm run test:security
npm run db:types
npm run lint
npm run typecheck
npm run check:translations
npm run test:unit
npm run test:browser
npm run test:a11y
npm run build
npm run scan:secrets
npm run check:dependencies
npm run db:types -- --check
```

If the ephemeral canary is absent in a later CI process, generate a new random
build-only `STILLROOM_SECRET_CANARY` without printing its value before build
and scan. It is a leak-detection fixture, never a production credential.

## Delivery rules

Continue the current feature branch/PR #2; do not reopen merged PR #1 or push to
`main`. **Every merge needs explicit user approval**, separately from plan,
code-review and CI approval. Never auto-merge. Finish Phase 0 only; do not start Phase 1, AI tagging, outfits,
calendar, unapproved production provisioning or paid services in the same task.
Only the coordinator's explicitly approved initialization of the dedicated
AI Wardrobe project is allowed; the source worker must not access hosted
credentials or run the local fixture/reset tools against that project.

Each later phase is a separately scoped cloud task after its predecessor's
exit evidence is reviewed. Keep the photo-first, editable draft and explicit
Save contract, three languages, isolated owners and deterministic outfits.

Before every implementation packet:

1. Read active root/Copilot instructions, cloud and phase/backend evidence,
   relevant blueprint requirements/work packets, actual schema/source/tests,
   PR body/discussion/diff/reviews and CI job logs. Record exact base/head,
   files actually consulted and unresolved gates.
2. Write a focused plan before edits. Obtain an actual different-provider,
   read-only critique; record provider/model, findings and amendments. The
   current plan was reviewed by **Anthropic Claude Opus 5**, as recorded by the
   coordinator in PR #2 comment `5559949209`. Automated validation/self-review is
   supplemental, not that prereview; do not invent a native review tool.
3. Coordinator approval of the amended plan precedes code. Explicitly select
   **GPT-6 Astra (`gpt-6-astra`)** and verify the actual implementation model
   using runtime/platform evidence, not its prompt. Stop if the model or
   required reviewer is unavailable; no Auto or silent fallback. This does
   not establish which model an unrelated coordinator session used.
4. Keep a single implementation writer. Routine in-scope review/fixes are
   coordinator work; consequential decisions go to the user. Material scope
   changes need renewed different-provider critique and coordinator approval.
5. Report exact validation commands/results and fresh-head CI status.
   Coordinator authorization governs CI reruns/approval; do not bypass it.
   Physical-phone/Safari, camera/library, VoiceOver and TalkBack acceptance
   remains a human gate, not something Chromium emulation or axe proves.

The setup workflow must be on the default branch before it can prepare cloud
agent sessions. It also supports a manual Actions run for setup diagnostics.
Cloud agent availability and usage are governed by the account's GitHub
Copilot settings and plan; no completion is implied merely by configuring
this file.

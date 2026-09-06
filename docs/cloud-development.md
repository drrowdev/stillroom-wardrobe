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

No production Supabase project, paid AI endpoint, larger runner, firewall
disablement or user-supplied production secret is required. The future hosted
Supabase region remains Stockholm (`eu-north-1`).

Setup failures are not passes: Copilot may still start in a partially prepared
environment. First inspect its setup log and `git status`, then confirm the
local stack with `npm run db:start` rather than assuming services survived.
Do not reset a useful in-progress fixture unless recovery requires it.

The generated `src/data/database.types.ts` can initially be untracked. Review
and commit it deliberately; never sweep `.env.local`, `.supabase`, browser
state, test results or logs into a commit. These are ignored. The test wrapper
passes ordinary fictional credentials to its child processes and strips
privileged/GitHub credentials.

## Active cloud task: finish Phase 0 on PR #1

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

The focused continuation follows [plan comment 5558504250](https://github.com/drrowdev/stillroom-wardrobe/pull/1#issuecomment-5558504250)
and [approval/amendments 5558542193](https://github.com/drrowdev/stillroom-wardrobe/pull/1#issuecomment-5558542193):
different-owner SDK broadcast regressions, bounded exact-token correction,
unapproved email admission checks, accurate provider/evidence documentation,
and persistent coordination rules. No schema, Auth configuration values,
setup workflow or phase expansion is authorized. Require fresh full CI for the
new head; baseline success is not transferable evidence or merge approval.

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

Continue the existing feature branch/PR #1, not a new PR or direct pushes to
`main`. **Every merge needs explicit user approval**, separately from plan,
code-review and CI approval. Never auto-merge. Finish Phase 0 only; do not start Phase 1, AI tagging, outfits,
calendar, production provisioning or paid services in the same task.

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
   coordinator in comment `5558542193`. Automated validation/self-review is
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

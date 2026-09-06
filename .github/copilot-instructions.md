Read root `AGENTS.md` as the main repository instruction source. These active
instructions and the root file must not be replaced by historical templates.

The root instructions now include the active cloud handoff; do not overwrite
them with older templates. Continue in a feature branch/PR using the prepared
Copilot cloud environment. Read `docs/cloud-development.md`, finish the
approved Phase 0 hosted-readiness packet on PR #2
(`copilot/phase0-hosted-backend-deployment`). Updated 6 September 2026:
PR #1 is merged; do not reopen it. Do not push to main, auto-merge or start
later phases.

Use `docs/cloud-development.md` for the exact hosted migration mapping,
read-only smoke inputs and coordinator/human gates. Local fixture tools must
never target hosted. The cloud receives no hosted credentials and runs no
hosted smoke, Auth setup or deployment. Cloudflare Pages is connected only to
the coordinator; automatic production/preview deployments are off. The queued
main deployment is not verified live evidence. Preserve comment `5560093343`
and do not replay the already-installed base migration or repair history.

Follow the root context/planning gate: read current instructions, phase/backend
evidence, relevant blueprint/work packets, actual schema/source/tests and PR
discussion/diff/reviews/CI logs; record exact base/head, files read and gates.
Plan before edits. Obtain actual different-provider critique and record its
reviewer/provider/model, findings and amendments; coordinator approval precedes
implementation. Material amendments repeat that gate. PR #2 comment
`5559949209` records the current approved plan and actual Anthropic Claude
Opus 5 critique; `5559976584` records hosted structural results. PR #1 comments
`5558504250` and `5558542193` remain historical evidence, not the active target.

Implementation must explicitly select GPT-6 Astra (`gpt-6-astra`); the
coordinator verifies the actual runtime/platform model, not merely the prompt.
No Auto, silent fallback, invented review tool or parallel writer. Stop when
required model/review is unavailable. The coordinator handles routine scoped
findings; consequential decisions go to the user. **Every merge requires fresh
explicit user approval**, regardless of plan approval or green CI.

For GitHub Copilot: work on the requested issue/phase, cite its blueprint requirement IDs in the PR, and report exact validation commands/results. Keep one focused work packet per PR. Do not auto-implement a suggested deferred feature or another phase. Accounts must have no relationship or sharing; the later user clarification in `blueprint/18-DECISIONS-ASSUMPTIONS-QUESTIONS.md` overrides the original attachment.

Revision 1.3 requires photo-first AI form filling (including title/category), editing all garment fields and explicit Save to library. Read `20`; no automatic library save or post-save worker. Outfits remain deterministic. Base SQL/results do not implement I29; paid activation still needs consent/allowances and setup approval.

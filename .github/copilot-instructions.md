Read root `AGENTS.md` as the main repository instruction source. These active
instructions and the root file must not be replaced by historical templates.

The root instructions now include the active cloud handoff; do not overwrite
them with older templates. Continue in a feature branch/PR using the prepared
Copilot cloud environment. Read `docs/cloud-development.md`, finish the
approved Phase 0 I01–I05 packet on existing PR #1 and do not open another PR,
push to main, auto-merge or start later phases.

Follow the root context/planning gate: read current instructions, phase/backend
evidence, relevant blueprint/work packets, actual schema/source/tests and PR
discussion/diff/reviews/CI logs; record exact base/head, files read and gates.
Plan before edits. Obtain actual different-provider critique and record its
reviewer/provider/model, findings and amendments; coordinator approval precedes
implementation. Material amendments repeat that gate. PR comments `5558504250`
and `5558542193` record the current plan and Anthropic Claude Opus 5 prereview.

Implementation must explicitly select GPT-6 Astra (`gpt-6-astra`); the
coordinator verifies the actual runtime/platform model, not merely the prompt.
No Auto, silent fallback, invented review tool or parallel writer. Stop when
required model/review is unavailable. The coordinator handles routine scoped
findings; consequential decisions go to the user. **Every merge requires fresh
explicit user approval**, regardless of plan approval or green CI.

For GitHub Copilot: work on the requested issue/phase, cite its blueprint requirement IDs in the PR, and report exact validation commands/results. Keep one focused work packet per PR. Do not auto-implement a suggested deferred feature or another phase. Accounts must have no relationship or sharing; the later user clarification in `blueprint/18-DECISIONS-ASSUMPTIONS-QUESTIONS.md` overrides the original attachment.

Revision 1.3 requires photo-first AI form filling (including title/category), editing all garment fields and explicit Save to library. Read `20`; no automatic library save or post-save worker. Outfits remain deterministic. Base SQL/results do not implement I29; paid activation still needs consent/allowances and setup approval.

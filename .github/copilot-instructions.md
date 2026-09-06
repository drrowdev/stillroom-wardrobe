Read root `AGENTS.md` as the main repository instruction source. These active
instructions and the root file must not be replaced by historical templates.

The root instructions now include the active cloud handoff; do not overwrite
them with older templates. Continue in a feature branch/PR using the prepared
Copilot cloud environment. Read `docs/cloud-development.md`. Assignment dated
6 September 2026: implement only the approved five-document Phase 0 handoff
amendment on PR #2 (`copilot/phase0-hosted-backend-deployment`), not a permanent
pin of separately approved future work. PR #1 is merged; do not reopen it.
Do not push to main, auto-merge or start later phases in this task.

Use `docs/cloud-development.md` for the exact hosted migration mapping,
read-only smoke inputs and coordinator/human gates. Local fixture tools must
never target hosted. The cloud receives no hosted credentials and runs no
hosted smoke, Auth setup or deployment. Cloudflare Pages is connected only to
the coordinator; automatic production/preview deployments are off. Coordinator
review `5125863611` records the reviewed-main shell reachable on 6 September
2026, 15:09 UTC; see the
[dated cloud-guide evidence](../docs/cloud-development.md#hosted-state-and-responsible-actors).
That supersedes queued as current status, not the historical worker observation,
and proves neither working Auth/Save/RLS nor full Phase 0. No PR #2 deployment.
Preserve comment `5560093343`; do not replay the installed base migration or repair history.

Follow the root context/planning gate: read current instructions, phase/backend
evidence, relevant blueprint/work packets, actual schema/source/tests and PR
discussion/diff/reviews/CI logs; record exact base/head, files read and gates.
Plan before edits. Obtain actual different-provider critique and record its
reviewer/provider/model, findings and amendments; coordinator approval precedes
implementation. Material amendments repeat that gate: changes to scope, allowed
files, authority, behaviour, gates or evidence claims, not typo/formatting edits.
PR #2 comment `5559949209` approved the completed source packet after actual
Anthropic Claude Opus 5 critique; `5559976584` records hosted structural results.
The 6 September documentation amendment follows
[plan 5560449572](https://github.com/drrowdev/stillroom-wardrobe/pull/2#issuecomment-5560449572)
and [approval 5560847183](https://github.com/drrowdev/stillroom-wardrobe/pull/2#issuecomment-5560847183),
including actual Anthropic Claude Opus 5 prereview and controlling amendments. PR #1 comments
`5558504250` and `5558542193` remain historical evidence, not the active target.

Before every implementation task and retry, explicitly select GPT-6 Astra
(`gpt-6-astra`); the coordinator verifies and records the actual runtime/platform
model for that task/session/time/base/head, never another task's evidence or a
name in a prompt. No Auto, silent fallback, unverified implementation or invented
review tool. Every new implementation plan/material amendment needs actual
different-provider read-only critique (reviewer/provider/model, findings and
amendments) and coordinator approval before edits; stop if model/reviewer is unavailable.

One writer on the shared **LOCAL** checkout does not prohibit coordinator-approved
independent **CLOUD** packets: initially at most **two implementation builders**
plus on-demand read-only review, one writer per workspace/branch/PR and one focused
approved packet per agent. Before launch the coordinator names active packets/
branches, owned files, dependencies and shared-resource owners. No concurrent
same-branch edits or shared-host mutations. No second builder until this corrected
common-base amendment is reviewed and merged into main with explicit user approval.
Session SQL/notes do not replace repository authority. Merges, hosted DDL and
deployments remain serialized and separately authorized. Concurrency itself grants
no new packet/PR, phase, dependency, provider or hosted authority. The coordinator
handles routine scoped fixes/reviews/CI; consequential decisions go to the user.
**Every merge requires fresh explicit user approval**, regardless of plan approval
or green CI; fresh-head validation remains required.

For GitHub Copilot: work on the requested issue/phase, cite its blueprint requirement IDs in the PR, and report exact validation commands/results. Keep one focused work packet per PR. Do not auto-implement a suggested deferred feature or another phase. Accounts must have no relationship or sharing; the later user clarification in `blueprint/18-DECISIONS-ASSUMPTIONS-QUESTIONS.md` overrides the original attachment.

Revision 1.3 requires photo-first AI form filling (including title/category), editing all garment fields and explicit Save to library. Read `20`; no automatic library save or post-save worker. Outfits remain deterministic. Base SQL/results do not implement I29; paid activation still needs consent/allowances and setup approval.

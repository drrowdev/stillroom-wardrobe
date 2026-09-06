Read root `AGENTS.md` as the main repository instruction source. During initial setup, copy the template from `blueprint/AGENTS.md` to root and this file to `.github/copilot-instructions.md`.

The root instructions now include the active cloud handoff; do not overwrite
them with older templates. Continue in a feature branch/PR using the prepared
Copilot cloud environment. Read `docs/cloud-development.md`, finish the
recorded Phase 0 blockers and do not auto-merge or start later phases.

For GitHub Copilot: work on the requested issue/phase, cite its blueprint requirement IDs in the PR, and report exact validation commands/results. Keep one focused work packet per PR. Do not auto-implement a suggested deferred feature or another phase. Accounts must have no relationship or sharing; the later user clarification in `blueprint/18-DECISIONS-ASSUMPTIONS-QUESTIONS.md` overrides the original attachment.

Revision 1.3 requires photo-first AI form filling (including title/category), editing all garment fields and explicit Save to library. Read `20`; no automatic library save or post-save worker. Outfits remain deterministic. Base SQL/results do not implement I29; paid activation still needs consent/allowances and setup approval.

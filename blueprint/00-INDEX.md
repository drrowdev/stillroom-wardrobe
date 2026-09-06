# Stillroom Wardrobe — build blueprint

Version 1.4 · 6 September 2026 · Working product/repository name: **Stillroom Wardrobe / stillroom-wardrobe**.

Design a private wardrobe for two completely independent accounts. The user’s later clarification removes every relationship and sharing feature from the original brief. This package specifies the app; it does not create a production repository, provision cloud services, invite anyone or deploy an app. All application behaviour in the package is **PROPOSED**, unless the research ledger explicitly labels it otherwise.

## Start here

1. Read `03-MVP-AND-NON-GOALS.md`, then the decision summary in `05-ARCHITECTURE.md`.
2. Review `10-SECURITY-AND-PRIVACY.md` and the executed-versus-pending checks in `validation/VALIDATION-REPORT.md`.
3. Extract this archive into a new repository so this directory is `blueprint/`. Copy `blueprint/AGENTS.md` to `/AGENTS.md` and `blueprint/.github/copilot-instructions.md` to `/.github/copilot-instructions.md`. Keep the originals in the package as templates.
4. Paste the Phase 0 prompt from `16-COPILOT-PROMPTS.md` into GitHub Copilot. `FIRST-COPILOT-PROMPT.txt` is the identical standalone prompt.
5. Complete each phase's exit test before starting the next. Read `20-AI-MODELS-AND-WORKFLOWS.md` before Phase 2; provider terms, model suitability and spending allowances must be confirmed before paid activation.

## Main decisions

| Decision | Result |
|---|---|
| Client | TypeScript, React, Vite; one mobile-first PWA; plain CSS and browser APIs |
| Data | Supabase project in **North EU (Stockholm), `eu-north-1`**; Auth, owner-protected Postgres and private Storage |
| Hosting | Cloudflare Pages Free for static assets; Azure Static Web Apps Free is the fallback |
| Admission | Two independent approved logins; administrative capacity only; no user-to-user relationship |
| Privacy | Owner-only app access; automatic tagging sends a sanitized photo to the chosen AI processor after that owner's setup consent. No account connections |
| Languages | English, Finnish and Swedish from Phase 0; independent owner preference, localized formatting and no automatic translation of personal content |
| Clothing details | Photo-first AI-filled form, including title/category; edit any garment field before explicit Save to library. No automatic library save or post-save enrichment; see `20` |
| Suggestions | Deterministic rules use the saved details; no AI outfit-generation or ranking call in the first release |
| Images | Locally cropped/re-encoded JPEG main and thumbnail; raw originals never uploaded |
| Offline | Installable shell, connection guidance and in-memory drafts; no persisted private wardrobe or photos |
| Budget | Free infrastructure where practical, separately bounded paid tagging; $0 is not a hard limit; backups outside live storage |
| MVP boundary | Phases 0–7. Trips and packing are optional Phase 8, outside the first release |

## File map

| File | Purpose / source of truth |
|---|---|
| `01-RESEARCH.md` | Twelve-source ledger, evidence labels and bounded product findings |
| `02-PRODUCT-REQUIREMENTS.md` | Requirement IDs and testable product outcomes |
| `03-MVP-AND-NON-GOALS.md` | Release boundary and deferred features |
| `04-USER-FLOWS-AND-SCREENS.md` | Screen IDs, journeys, original design tokens and accessibility behaviour |
| `05-ARCHITECTURE.md` | Platform comparison, dependency decisions and trust boundaries |
| `06-DATA-MODEL.md` | Entity meanings, relationship diagram and history semantics |
| `07-DATABASE-AND-RLS.sql` | Executable revision 1.1 base schema; the additional AI migration is specified in `20` and implemented in I29 |
| `08-API-AND-STORAGE.md` | Contracts, error handling, image lifecycle and portable export format |
| `09-RECOMMENDATIONS.md` | Candidate generation, hard rules, scoring, explanations and quality cases |
| `10-SECURITY-AND-PRIVACY.md` | Threat model, secrets, private access and data deletion |
| `11-COST-AND-HOSTING.md` | Dated provider allowances, calculations and operational thresholds |
| `12-TEST-STRATEGY.md` | Access matrix, requirement traceability and release gates |
| `13-REPOSITORY-STRUCTURE.md` | Exact file layout, commands, environments and CI requirements |
| `14-IMPLEMENTATION-PLAN.md` | Ordered phases, dependencies, exit checks and rollback points |
| `15-GITHUB-ISSUES.md` | Pull-request-sized implementation packets |
| `16-COPILOT-PROMPTS.md` | Paste-ready instructions for every phase |
| `17-DEPLOYMENT-AND-RECOVERY.md` | Provisioning, deployment, backups, restore and migration runbooks |
| `18-DECISIONS-ASSUMPTIONS-QUESTIONS.md` | Decision consequences, assumptions and human setup inputs |
| `19-LOCALIZATION.md` | English/Finnish/Swedish behavior, account preference, formatting, backup compatibility and release gates |
| `20-AI-MODELS-AND-WORKFLOWS.md` | AI task/models, pre-save form filling, uncertainty, request receipts, budgets, consent and migrations |
| `21-AI-MODEL-COMPARISON.md` | Dated comparison of current Google/OpenAI/Anthropic/Mistral image models, eligibility, costs, residency and selection criteria |
| `AGENTS.md` | Coding-agent repository rules template |
| `.github/copilot-instructions.md` | Copilot-specific pointer template |
| `FIRST-COPILOT-PROMPT.txt` | Exact Phase 0 prompt for easy copying |
| `reference-scripts/export-own.mjs` | Owner-authenticated, encrypted export reference helper |
| `reference-scripts/locales.json`, `reference-scripts/i18n.mjs` | Trilingual starter catalog and tested language/formatting reference helpers |
| `reference-scripts/20260905000001_languages.sql` | Additive upgrade only for an already-applied revision 1.0 schema; fresh projects use updated `07` |
| `validation/` | PostgreSQL, translation, browser-image, crypto and consistency checks; real-session HTTP harness; reports and synthetic fixtures |

## Governing clarification

The latest user instruction takes precedence: the two profiles must have no relationship or connection. The app exposes only the signed-in person’s data. Neither account can discover the other. Administrative approval of two independent logins is not a household model. No sharing code or data structure is included.

## Status and limitations

The full SQL was executed in an embedded PostgreSQL engine with minimal Supabase schema stubs. Authorization checks run as `authenticated`, with simulated JWT identity claims. They validate PostgreSQL policy behaviour, **not** Supabase Auth, its real Storage service, or an implemented Edge Function. The normal-session HTTP harness is supplied but cannot be executed without a configured project and two test logins. These are explicit Phase 0/5 gates, not claimed passes.

The image-processing contract prototype passed in Chromium; this is not a completed app or physical-phone test. Accessibility, full restore, deletion Edge Function and app performance remain implementation gates. Exact package versions and transitive notices are frozen during Phase 0 installation; no production lockfile is claimed here. See the validation report for the final package checks.

Revision 1.1 adds 234 English/Finnish/Swedish message keys, tested formatting helpers, an owner-only language preference and an additive SQL upgrade. Reference translation and database isolation checks passed; real UI integration and native-speaker review remain implementation gates.

Revision 1.3 supersedes revision 1.2's post-save workflow: select a photo, automatically fill an editable draft, then explicitly Save to library. R28/I29 now includes automatic title/category and description editing, an analysis endpoint rather than a tagging worker, and no analysis-triggered library writes. Models remain researched candidates and outfits remain deterministic. Base SQL/reference results are historical revision 1.1 artifacts; the new migration, endpoint, translations and metadata-v2 recovery still require implementation.

Revision 1.4 selects Stockholm for the Supabase project and adds a fresh multi-provider comparison. Gemini 3.5 Flash-Lite on Google Cloud EU remains a provisional starting configuration, not a proven accuracy winner. GPT-5.4 Mini and GPT-5.6 Luna join the primary comparison; Terra is no longer the sole alternative. Provider eligibility, actual regional access and correction effort decide adoption. No cloud project was created or moved.

If files disagree: scope lives in `03`, base data enforcement in `07`, API semantics in `08`, scoring in `09`, costs in `11`, work order in `14`, localization in `19`, and the new AI contract in `20`. Correct conflicts before coding; do not silently weaken privacy or treat a planned migration as implemented.

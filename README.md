# Stillroom Wardrobe

A calm, photo-first wardrobe app with completely independent private accounts.
The source is public; wardrobe data, photos, credentials and backups are not.

## Development in GitHub

The active development environment is **GitHub Copilot cloud agent**, prepared by
`.github/workflows/copilot-setup-steps.yml`. It installs Node, Chromium and a
disposable Supabase stack without production secrets. Continue through feature
branches and pull requests; no automatic merge or paid-service activation.
See [cloud development and handoff](docs/cloud-development.md).

**Phase 0 is still in progress.** As of 6 September 2026, PR #1 is merged and
PR #2's bounded hosted-readiness packet is merged. PR #3 adds only the approved
password-recovery Auth unblocker, not Phase 1 or hosted acceptance.
See the [dated shell/dashboard evidence and remaining gates](docs/cloud-development.md#hosted-state-and-responsible-actors).
Ordinary password login, own Save/reload, negative RLS/Storage, prepared fixtures,
live hosted smoke and physical-device acceptance remain open. No later phase or
automatic merge is authorized.

## Current implementation

Phase 0 builds the foundation: invited-account sign-in, an owner-only wardrobe,
English/Finnish/Swedish, local JPEG preparation and an editable draft that is saved
only when the owner chooses **Save to my wardrobe**.

Password recovery requests an email without promising eligibility or delivery.
Open its link in a fresh page with no opener or existing sign-in, confirm the
server-verified account explicitly, then choose a new password (at least 24
characters, at most 72 UTF-8 bytes). Passwords are not trimmed or normalized.
The isolated recovery session never becomes a wardrobe session. After success,
the app requests global sign-out for the recovered owner and returns to ordinary
Login; existing access JWTs may remain valid until expiry. Cancellation cannot
undo an already-transmitted update. See the [local-only proof and limits](docs/local-backend.md#real-local-password-recovery).

The first slice uses manual names/categories. Automatic AI form filling belongs
to Phase 2 and is not simulated here. Outfits, calendar, statistics, full backup restoration
and account deletion are later phases; no unfinished screen is presented as working.
The app has an initial manifest, but complete installation/offline acceptance remains
a later release gate.

## Local development

Use Node 24 and npm. Docker Desktop is required for the local Supabase services.
On Windows, use `npm.cmd` if PowerShell blocks the `npm.ps1` wrapper.

```text
npm ci
npm run db:start
npm run db:reset
npm run dev
```

`db:reset` is restricted to this disposable local stack; it must never target a
hosted project. The provisioning tools create fictional test accounts, keeping
their credentials in ignored local state. See [local backend setup](docs/local-backend.md).

Copy `.env.example` to `.env.local` and set only the local project URL and
publishable key as described in that guide. Restart Vite after configuration changes.
Without backend settings, the app intentionally displays a setup screen rather
than a fake wardrobe.

Never put a service-role key, database password, deployment token or AI key in a
`VITE_` variable. Do not commit `.env.local`, `.supabase`, account fixtures, photos,
backups or browser session state.

## Quality gates

```text
npm run lint
npm run typecheck
npm run check:translations
npm run test:unit
npm run test:browser
npm run build
npm run scan:secrets
npm run check:dependencies
npm run test:integration
npm run test:security
npm run db:types -- --check
```

Browser fixtures exercise UI and request contracts; they are not evidence of
Supabase authorization. The separate real-stack CI job signs in using ordinary
test accounts and must pass before Phase 0 is considered complete. Missing Docker
or credentials are reported as unavailable gates, not successful tests.
`test:integration` now also runs the real local mail/reset/browser journey with
ordinary fictional accounts and mandatory password/data cleanup. Do not run it
concurrently with security tests or against hosted; missing mail or uncertain
cleanup is nonzero, not a skipped pass.

Database types in `src/data/database.types.ts` are generated from the real local
Supabase schema with `npm run db:types`; `npm run db:types -- --check` fails if the
committed file drifts. `src/data/rows.ts` narrows the generated rows the
application relies on.

## Deployment and privacy

The coordinator installed the exact base schema once in the approved **AI
Wardrobe** Supabase project, `xwrdrugastphdiihzuia`, **Stockholm (`eu-north-1`)**.
This is structural evidence, not working hosted login or ordinary-user RLS proof.
The source-to-remote migration versions differ: see the
[mapping and actor/gate handoff](docs/cloud-development.md#hosted-state-and-responsible-actors).
Do not run hosted `db push`, replay/reset, history repair or local fictional
provisioning. Edge Functions and AI processing have separate location controls;
no AI service is activated.

The coordinator created git-backed Cloudflare Pages project `stillroom-wardrobe`
with automatic production and preview deployments disabled. Coordinator review
`5125863611` records the reviewed-main shell at `https://stillroom-wardrobe.pages.dev`
reachable on 6 September 2026, 15:09 UTC; see the
[deployment-specific evidence](docs/cloud-development.md#hosted-state-and-responsible-actors).
This supersedes queued as current status, not the historical worker observation.
Any replacement needs fresh evidence. No PR #2 deployment, deployment workflow,
Functions or paid hosting.
Production uses only the three public VITE settings and build-only Node version.
A reachable shell does not complete hosted login, Save, Storage/RLS or phone gates.

The separate `node scripts/hosted-smoke.mjs` command is for an approved private
operator only, with explicit opt-in, the exact hosted URL, two ordinary sessions
and pre-existing non-personal fixtures. It makes no writes and logs no private
details. Missing evidence exits BLOCKED/nonzero; unit mocks are not live proof.
See [private smoke inputs and outcomes](docs/cloud-development.md#private-read-only-hosted-smoke).
Do not supply hosted credentials to the cloud agent, repository or public CI.

Only static build files go to Cloudflare Pages. Database and Storage policies enforce
owner access. Session tokens use sessionStorage; private wardrobe content and images
are never stored in persistent browser caches. Project operators remain trusted
administrators; the app does not claim end-to-end encryption.

The checked-in [blueprint](blueprint/00-INDEX.md) defines phase order and remaining
work. [Phase 0 status](docs/phase-0-result.md) records the implemented scope and
outstanding gates.

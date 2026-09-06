# Stillroom Wardrobe

A calm, photo-first wardrobe app with completely independent private accounts.
The source is public; wardrobe data, photos, credentials and backups are not.

## Development in GitHub

The active development environment is **GitHub Copilot cloud agent**, prepared by
`.github/workflows/copilot-setup-steps.yml`. It installs Node, Chromium and a
disposable Supabase stack without production secrets. Continue through feature
branches and pull requests; no automatic merge or paid-service activation.
See [cloud development and handoff](docs/cloud-development.md).

**Phase 0 is still in progress.** The cloud continuation first resolves the
recorded browser issues and real backend/type-generation gates before moving on.

## Current implementation

Phase 0 builds the foundation: invited-account sign-in, an owner-only wardrobe,
English/Finnish/Swedish, local JPEG preparation and an editable draft that is saved
only when the owner chooses **Save to my wardrobe**.

The first slice uses manual names/categories. Automatic AI form filling belongs
to Phase 2 and is not simulated here. Outfits, calendar, statistics, full recovery
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

Full database types come from the real local Supabase schema. Until that generation
is completed, `database-projection.ts` supplies explicit Phase 0 projections plus
runtime validation; it is not represented as a generated full-schema file.

## Deployment and privacy

The planned hosted Supabase region is **Stockholm (`eu-north-1`)**. Edge Functions
and AI processing have separate location controls. No hosted Supabase or AI service
is provisioned by installing this repository.

Only static build files go to Cloudflare Pages. Database and Storage policies enforce
owner access. Session tokens use sessionStorage; private wardrobe content and images
are never stored in persistent browser caches. Project operators remain trusted
administrators; the app does not claim end-to-end encryption.

The checked-in [blueprint](blueprint/00-INDEX.md) defines phase order and remaining
work. [Phase 0 status](docs/phase-0-result.md) records the implemented scope and
outstanding gates.

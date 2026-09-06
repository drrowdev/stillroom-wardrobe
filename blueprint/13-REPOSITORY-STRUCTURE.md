# Repository structure and commands

The user chose a **public GitHub source repository**, `drrowdev/stillroom-wardrobe`; application accounts/photos/data remain private. The planned structure is one PWA, Supabase migrations, pre-save analysis and separate deletion, without a background tagging worker. Outfits stay deterministic. Never publish credentials, personal fixtures, images or backups.

## Layout

| Path | Responsibility |
|---|---|
| `/AGENTS.md` | Copy the supplied agent-rules template here |
| `/.github/copilot-instructions.md` | Copy the supplied Copilot pointer here |
| `/.github/workflows/ci.yml` | Install, static checks, tests, local Supabase security gate, production build and secret scan |
| `/blueprint/` | This reviewed specification package; retain the latest no-connection instruction |
| `/src/app/` | Root, hash routes, shell, error boundary, account-bound state and navigation |
| `/src/auth/` | SDK session, membership check, login/password update and logout cleanup |
| `/src/features/profile/` | S02 profile/preferences |
| `/src/features/wardrobe/` | S04–S06 item grid/editor/detail and own search |
| `/src/features/outfits/` | S07–S09 builder/detail and RPC adapter |
| `/src/features/calendar/` | S10 local-date plans and wear events |
| `/src/features/statistics/` | S11 owner-only derived counts and currency groups |
| `/src/features/settings/` | S12 settings/export/restore/deletion and S13 trash |
| `/src/features/today/` | S03 context, suggestions, explanations and feedback |
| `/src/domain/` | Pure taxonomy, dates, item types, rule engine, money and export schema |
| `/src/i18n/` | `messages.json`, typed keys/context, native-name selector, pure negotiation and Intl formatting; copy/adapt the references in `19` |
| `/src/data/` | Supabase client, generated database types, owner repositories and RPC/error mapping |
| `/src/images/` | Validation, orientation/crop/encode, hash, reservation and Blob lifecycle |
| `/src/providers/` | Weather adapter and disabled image-enhancement interface; no browser AI credentials/calls |
| `/src/features/wardrobe/automatic-details.tsx` | Photo-first editable draft/prefill, stale-result guards and explicit Save/discard in the existing editor |
| `/src/data/automatic-details.ts` | Authenticated analysis/result/discard adapter; no direct request/usage table access |
| `/src/styles/` | Tokens and plain component CSS |
| `/public/` | Original icons/manifest and static assets only; never user photos or exports |
| `/src/service-worker.ts` | Static-shell allowlist cache only; never intercept/cache private API responses |
| `/supabase/config.toml` | Local services, public signup disabled, deletion-function auth configuration |
| `/supabase/migrations/20260905000000_initial.sql` | Exact reviewed SQL from `07`; future migrations additive and reviewed |
| `/supabase/migrations/20260906000000_automatic_tagging.sql` | Planned I29 consent/provenance, requests/usage, checked Save and description-edit operations; not implemented here |
| `/supabase/functions/analyze-clothing/index.ts` | User-authenticated pre-save photo analysis returning validated draft fields; no inventory writes |
| `/supabase/functions/_shared/ai/` | Server-only provider authentication/adapter, pinned model config and response schema |
| `/supabase/functions/delete-account/index.ts` | User verification, password reauth, owner-derived deletion stages |
| `/scripts/` | Provision test users, export, verify backup, restore, owner cleanup, operator recovery and secret scan |
| `/scripts/check-translations.mjs` | Catalog completeness, parameter/plural parity and translated UI usage gate for all three languages |
| `/tests/unit/` | Pure scoring, dates, costs, image header, format and mapping fixtures |
| `/tests/integration/` | Transaction, image lifecycle, export/restore and deletion integration tests |
| `/tests/security/rls.sessions.mjs` | Normal A/B/anonymous HTTP harness copied/adapted from `validation/security-sessions.mjs` |
| `/tests/security/` | Additional RPC, storage, no-connections, cache, export and deletion assertions |
| `/tests/browser/` | Playwright user journeys, accessibility and responsive checks |
| `/tests/fixtures/` | Fictional clothes and generated image fixtures without personal content |
| `/docs/dependencies.json` | Exact production dependency inventory including all transitive packages |
| `/docs/operations.md` | Environment names, latest restore drill and provider quota checks, no secrets |
| `/THIRD-PARTY-NOTICES.txt` | Resolved package licence notices |

There is intentionally no `household`, `sharing`, `peers`, `social`, native app, AI chat or media gateway folder. Optional Phase 8 can add `features/trips` only after authorization and a new owner-only migration.

## Package and naming rules

Use TypeScript strict mode and ES modules. Component names PascalCase; domain/repository files kebab-case; SQL identifiers snake_case. UUIDs are generated once per create attempt, not on rerender. Money remains a decimal string at the SQL boundary and is converted to integer minor units for deterministic calculations where the currency supports them; do not use binary floating-point storage. V1 allows any uppercase currency code syntactically but the UI accepts an `Intl`-supported ISO currency and uses its fraction digits for display. Store prices with at most two decimals as the chosen MVP constraint; no live FX.

Resolve direct runtime packages with `npm install --save-exact react@19 react-dom@19 @supabase/supabase-js@2`. These are chosen compatibility families, not a claim about today's latest patch. Install current compatible stable build/test tools and save exact versions. Commit `package-lock.json`; subsequent installations use `npm ci`. Review actual licence/security/maintenance metadata before accepting the lockfile, including transitive packages. No additional runtime package without the decision record in `05`.

## Environment variables

| Scope | Values |
|---|---|
| Browser allowlist | `VITE_SUPABASE_URL`, `VITE_SUPABASE_PUBLISHABLE_KEY`, `VITE_APP_VERSION` |
| Normal-session test process | `SUPABASE_URL`, `SUPABASE_PUBLISHABLE_KEY`, `TEST_A_EMAIL`, `TEST_A_PASSWORD`, `TEST_B_EMAIL`, `TEST_B_PASSWORD`, `ALLOW_SECURITY_TESTS=1` |
| Setup only | `SUPABASE_SERVICE_ROLE_KEY`, local database connection, two approved test emails/passwords; not inherited by the security-test child process |
| Deployment/operations only | Supabase management/project access, migration DB credential, Cloudflare deployment token if used; read only by the particular command needing it |
| Deletion function only | `SUPABASE_URL`, server publishable/anon key, `SUPABASE_SERVICE_ROLE_KEY`, `ALLOWED_ORIGIN`; no VITE prefix |
| AI endpoint only | Selected provider credentials, model/region/prompt configuration and restricted receipt/usage access; never VITE-prefixed |
| Backup process only | Own login credential/token from OS credential storage and passphrase prompted securely; never command-line literal arguments or repository files |

Commit `.env.example` with empty placeholders only. Ignore `.env`, `.env.*.local`, credentials, backup/export files, `.supabase` local state, `dist`, test session state and `node_modules`. No real email is committed even as a sample.

## Commands Copilot must implement

```bash
npm ci
npm run dev
npm run lint
npm run typecheck
npm run test:unit
npm run db:start
npm run db:reset
npm run db:types
npm run test:integration
npm run test:security
npm run test:browser
npm run test:a11y
npm run build
npm run scan:secrets
npm run check:dependencies
npm run check:translations
```

`db:start` invokes the pinned Supabase CLI local stack and requires Docker. `db:reset` applies migrations only to the disposable local stack, provisions the two fictional users through a separate admin fixture, and writes no password to logs. `db:types` generates TypeScript from the local schema; CI fails if committed generated types differ. `test:security` refuses missing test flags and service secrets, signs in normally and returns nonzero on any failure. It must not silently skip unavailable services in CI.

`test:unit` uses Vitest; browser/a11y use Playwright and axe. `scan:secrets` scans tracked source, built JS, source maps and environment use; rejects `sb_secret_`/legacy service JWT patterns and a supplied canary. `check:dependencies` enumerates resolved production packages, validates SPDX/licence notices and maintenance metadata, and checks critical advisories. `npm audit --omit=dev --audit-level=critical` is part of that gate, not a complete security review.

I29 adds request/budget/provenance, zero-before-Save writes and description-edit cases to existing commands. Inventory backend packages separately; no browser AI SDK. CI uses fictional fixtures, not paid inference or personal photos. The authorized model sample remains an operator-run gate after terms/allowance approval.

`check:translations` runs on every PR. Adapt the delivered catalog/helper checks to the typed application paths, check every referenced UI key and fail missing English/Finnish/Swedish strings or placeholder/plural mismatches. Add unit cases for negotiation, Nordic text and localized date/price handling, plus three-language browser journeys. No language preference belongs in a VITE environment variable or shared global configuration. If the old initial SQL was already committed/applied, use the additive language migration from `19`, never rewrite its history or reset live data.

## CI and environments

Local development uses Docker Supabase with fictional accounts; no production data. Pull requests run lint, strict types, pure tests, fresh local migrations, user-session security/integration tests, browser/a11y smoke checks, build and secret/dependency scans. Use least-privilege `contents:read` by default and no deployment secrets on untrusted/fork pull requests. Keep artifacts short-lived and exclude tokens/photos/export contents.

Main builds deployable static `dist/`; Cloudflare Git integration can deploy it after required CI is green. Configure automatic deployment only as described in `17`; it publishes the public shell, never private data. Preview builds use only local/disposable non-production backends; never point arbitrary PR code at production. A remote staging project is optional within the two-project free limit, not required for the first slice. Rollbacks restore a known static commit; schema changes are forward-compatible or separately rolled back from a verified backup.

CI cannot prove Safari camera behaviour or certify accessibility. Record actual-device checks and the restore drill as Phase 7 release evidence.

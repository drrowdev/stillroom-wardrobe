# Phase 0 - work in progress

Date: 6 September 2026. Initial local implementation handed to GitHub Copilot
cloud development. **The Phase 0 exit gate has not passed.**

## Implemented foundation

* React/TypeScript/Vite application with original responsive styling.
* English/Finnish/Swedish sign-in, configuration, wardrobe and manual draft UI.
* Supabase SDK sessions, owner profile/language loading, private data guards,
  cross-tab logout and cancellation of obsolete data requests.
* JPEG preparation with bounded sanitized main/thumbnail files, explicit
  reviewed Save, immutable owner paths and retry reconciliation.
* Verbatim revision 1.1 base migration, guarded disposable local provisioning,
  ordinary-session integration/security runners and actual type-generation command.
* CI, license inventory, secret/canary scanning and Copilot cloud setup.

No paid AI, later-phase feature, production backend or public photo storage has
been enabled. The source repository is public at the user's request.

## Recorded local commands and outcomes

| Command / scope | Outcome |
|---|---|
| `npm run typecheck` | Exit 0 |
| `npm run lint` | Exit 0 |
| `npm run check:translations` | Exit 0; 298 keys in three languages |
| `npm run test:unit` | Exit 0; 108 tests across six files |
| `npm run build` | Exit 0; initial compressed JavaScript approximately 140.60 kB |
| `npm run scan:secrets` with ephemeral canary | Exit 0; no reported finding |
| `npm run check:dependencies` | Exit 0; 12 production / 220 development packages; production audit reported no vulnerabilities |
| JPEG browser module suite | Agent-reported 20 passing desktop/mobile Chromium cases |
| `npm run test:browser -- slice.spec.ts --project=chromium` | Exit 1; 8 passed, 2 failed |
| Local `db:start`, `db:reset`, `db:types`, `db:types --check` | NOT RUN / exit 2 because Docker is unavailable on this machine |
| Real Auth/Storage integration and security | Not executed locally; no pass claimed |

The successful browser fixtures are UI/request-contract evidence only. They
are not real Supabase authentication or RLS evidence. No actual phone,
VoiceOver or TalkBack acceptance is claimed.

## Remaining blockers

* Cross-tab browser case timed out looking for the second sign-in form after
  signing into the first tab. Investigate SDK session synchronization and
  keep the intended logout assertion; do not simply skip the test.
* Accessibility case reports `.workspace-identity` outside a landmark.
* Real local Supabase gates and full generated schema types are pending.
  `database-projection.ts` is explicitly a temporary typed projection, not
  generated-schema evidence.
* Physical-device behavior remains unverified.

The local preview responds at `http://127.0.0.1:5173`. Without Supabase settings
it displays an honest setup screen, not simulated private wardrobe data.
See `cloud-development.md` for the cloud continuation task.

## Publication and rollback

This is an initial WIP source snapshot, not a deployed release. No prior
production application or data is changed. Stop the preview or revert the
new source commit to roll back; never reset a live database. Subsequent
cloud work must use a pull request and update this report with actual
commands, results, commit and remaining limits.

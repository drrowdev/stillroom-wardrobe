# Phase 0 - result

Date: 6 September 2026. Initial local implementation continued in GitHub
Copilot cloud development. The recorded blockers are fixed and the gates below
were re-run for real, with the sandbox limits stated under "Remaining limits".
The exit gate is proposed for review, not self-approved.

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

Re-run in the GitHub Copilot cloud session against the disposable local
Supabase stack (Docker) on 6 September 2026.

| Command / scope | Outcome |
|---|---|
| `npm run typecheck` | Exit 0 |
| `npm run lint` | Exit 0 |
| `npm run check:translations` | Exit 0; 299 keys in three languages |
| `npm run test:unit` | Exit 0; 108 tests across six files |
| `npm run test:browser` (slice suite, chromium and mobile) | Exit 0; 20 passed |
| JPEG browser module suite | Exit 0; 20 desktop/mobile cases |
| `npm run build` | Exit 0; initial compressed JavaScript approximately 140.87 kB |
| `npm run scan:secrets` with ephemeral canary | Exit 0; 124 text files checked, canary checked |
| `npm run check:dependencies` | Exit 0; 12 production / 220 development packages; production audit reported no vulnerabilities |
| `node scripts/provision-test-users.mjs` | Exit 0 after the Auth configuration repair |
| `ALLOW_SECURITY_TESTS=1 npm run test:integration` | PASS; normal password sessions only, no service key |
| `ALLOW_SECURITY_TESTS=1 npm run test:security` | PASS; nine stages, normal password sessions only |
| `npm run db:types` and `npm run db:types -- --check` | Exit 0; committed types exactly match actual local generation |
| `npm run db:start` / `npm run db:reset` | Not completed end to end in this sandbox; see limits below |

## Repaired defects

* Local sign-in failed with `FAIL: a provisioned local identity could not sign
  in`. The Supabase CLI maps `[auth.email].enable_signup` to GoTrue's
  `GOTRUE_EXTERNAL_EMAIL_ENABLED`, which disables the whole email provider,
  including password sign-in for administratively created identities. The
  option is now enabled in `supabase/config.toml`. Self-service signup stays
  closed by `[auth] enable_signup = false` and by the database admission
  trigger; both anonymous signup denials are still asserted by the security
  suite.
* `src/data/database.types.ts` is now generated from the actual local schema
  and committed; the temporary `database-projection.ts` was removed and the
  client, profile access and tests use the generated types through
  `src/data/rows.ts`.
* The security fixture inserted rows with non-uniform keys, which PostgREST
  rejects (`PGRST102`), and omitted the non-null `items.notes` column. The
  fixture now sends uniform rows; no policy or assertion was weakened.
* `.workspace-identity` is now an `aside` landmark with a translated label, so
  all page content sits inside landmarks.
* The accent colour was darkened to `#9C5840` to reach the 4.5:1 contrast ratio
  for small text on the application background.
* A tab adopted another tab's sign-in because the Supabase SDK broadcasts
  session events between tabs. Sessions are per-tab `sessionStorage`, so the
  session controller now ignores any session this tab does not hold. The
  explicit logout broadcast and its assertions are unchanged, and the browser
  test additionally asserts that the second tab still shows its own sign-in
  form.

## Remaining limits

* This agent sandbox blocks name resolution for Docker containers created after
  the session started, so `supabase start` and `supabase db reset` (and
  therefore `npm run db:reset` end to end) could not run here. The schema was
  applied to the existing local database and the Auth, REST and Storage
  containers were recreated manually with host mappings so that the real gates
  above could run against normal sessions. Image pulls from the CloudFront
  backed registry are blocked as well, so the `postgres-meta` image used by
  type generation was pulled from Docker Hub and re-tagged locally. These are
  environment workarounds only; nothing about them is committed, and
  `npm run db:reset` still needs one clean run on the CI runner.
* Physical-device behaviour remains unverified: no real phone, VoiceOver or
  TalkBack acceptance is claimed. Browser evidence is Chromium desktop and
  emulated mobile only.
* No paid AI, later-phase feature, production backend or hosted Supabase
  project has been enabled. AI prefill remains Phase 2 scope.

The local preview responds at `http://127.0.0.1:5173`. Without Supabase settings
it displays an honest setup screen, not simulated private wardrobe data.
See `cloud-development.md` for the cloud continuation task.

## Publication and rollback

This is an initial WIP source snapshot, not a deployed release. No prior
production application or data is changed. Stop the preview or revert the
new source commit to roll back; never reset a live database. Subsequent
cloud work must use a pull request and update this report with actual
commands, results, commit and remaining limits.

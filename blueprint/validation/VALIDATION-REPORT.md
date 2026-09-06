# Blueprint validation report

Checked **5 September 2026**. This report evaluates a documentation/SQL package and small reference prototypes. **No production app was built or deployed.** All test inputs are fictional or generated; no personal photos, passwords or existing user data were used.

**Revision 1.4, 6 September 2026:** Stockholm is the selected project region; `21` adds a fresh official-documentation model comparison. No project was migrated/provisioned, no account-specific model access was established and no garment inference results were produced. Structural checks of region/model references are not model-quality evidence.

**Current revision 1.3, 6 September 2026:** the plan now requires photo-first automatic form filling, editing before explicit Save, and no post-save tagging worker. R28/I29 includes an analysis endpoint, bounded result/usage receipts and narrow description editing. These are documentation changes, not implemented application/database behavior. The package checker covers their structural consistency; it cannot prove an AI or UI flow. The SQL and result JSON below remain revision 1.1 evidence.

**Historical revision 1.2 note:** the earlier post-save jobs/worker design is superseded by 1.3. No AI migration, provider integration, additional catalog or metadata-v2 recovery implementation was validated by the original artifacts. Do not rewrite historical SQL/image/crypto results to imply otherwise.

## Executed checks

| Check | Actual result | Evidence and practical limit |
|---|---|---|
| PostgreSQL migration and policy execution | **17 check groups PASS** | `sql-results.json`; `check-sql.mjs` runs the complete migration in PGlite PostgreSQL with minimal Supabase schema stubs, then simulates the old profile schema on fictional rows and applies the additive language upgrade. Existing profile values are preserved. Normal-role assertions use `authenticated` and simulated JWT identity claims. This is not a Supabase password-session test. |
| Account independence | **PASS within PostgreSQL** | Both directions across all ten public private-data tables, forged ownership/foreign FKs, Storage metadata paths, RPCs, anonymous access and own-only exports. A saves Finnish and B Swedish; foreign language changes have no effect, unsupported codes fail and timezone/currency stay unchanged. All twelve application tables enable RLS; no relationship/discovery entity exists. |
| Recovery SQL | **PASS within PostgreSQL** | Historical text survives item removal; feedback IDs are owned and signatures derived; retirement timestamps preserve the recovery window; disabling/deleting A leaves all B rows unchanged. Privileged deletion-controller stage checks are separately labelled and use stub object metadata, not real file-byte deletion. |
| Browser image contract | **13 synthetic cases PASS** | `browser-results.json`; Chromium 149.0.7827.0. All eight EXIF orientations have correct dimensions/corner pixels and GPS-bearing input EXIF plus XMP is removed. JPEG/PNG/WebP, dense images, no-upscale and both byte caps pass. |
| Compression fallback | **PASS** | Dense noise exercised dimension reduction to 1156 × 1156, producing 507,863 main-image bytes. This demonstrates the algorithm's bounds, not real-photo quality or phone memory performance. |
| Mermaid syntax | **3 diagrams PASS** | Parsed using Mermaid 11.17.2 in Chromium: journeys, architecture and entity relationships. A valid diagram is not proof of security. |
| Backup serialization/encryption | **7 check groups PASS** | `backup-results.json`; canonical serialization, known SHA-256 vector, AES-GCM round trips, exact KDF parameters, wrong-password/tamper rejection and independent part salt/IV. No live image export or full restore was run. |
| Language catalog and reference helpers | **234 keys; 8 check groups PASS** | `localization-results.json`; every key has English/Finnish/Swedish values with matching parameters and plural pairs. Negotiation, fallbacks, decimal input, currency/date presentation and Nordic text checks pass. This does not validate an implemented UI or native-speaker review. |
| Static package consistency | **9 check groups PASS** | `package-results.json`; all 21 originally requested files plus the localization additions, 27 requirement-to-test mappings, 28 ordered issue packets, optional phase boundary, exact first prompt, nine phase prompts, 12-source ledger, code fences/file references and platform totals. |
| Design-token contrast | **12 pairings PASS** | Exact ratios are in `package-results.json`. White on the clay accent is 4.92:1; secondary ink on ivory is 5.43:1. Final component combinations still need review. |
| JavaScript syntax and missing-configuration guard | **PASS for syntax; live tests NOT RUN** | Node parsed the supplied `.mjs` helpers. Running `security-sessions.mjs` without credentials returned exit 2 and `NOT RUN`, without making network calls. See `live-status.json`. |

SQL SHA-256: `4f2d44603707cb823527c80d8384c2a6390f99ead2ba294435db83403a7eead5`. This binds the policy results to the delivered revision 1.1 migration. `sql-results.json` also records the additive upgrade hash. Checks are grouped assertions, not an application test count.

## What has not been proved

* **Real Supabase Auth/REST/Storage:** no project, Docker stack or normal test credentials were supplied. `security-sessions.mjs` is an executable starting harness which signs in as two ordinary users and refuses service keys. Configure a disposable local stack and execute it in Phase 0; repeat against the final feature set in Phase 5/7.
* **Deletion Edge Function:** the server-only SQL controller was tested, but JWT verification, password reauthentication, real Storage-byte removal, CORS and Auth Admin integration are future implementation tests.
* **App behaviour:** no UI, production bundle, routing, caching, XSS handling, recommendation engine, calendar, account-switch flow or provider integration was implemented here. Their named tests in issue packets are work for Copilot.
* **Language integration and wording:** the catalog/helpers pass locally; a real language selector, saved-setting conflicts, login/account-switch behaviour, localized screen-reader output, long-label layouts and native-speaker review still need the implemented app. The updated normal-session harness includes owner-only language tests but has not run against Supabase.
* **Physical phones/accessibility:** Chromium's synthetic canvas prototype does not validate Safari/HEIC, HTMLImageElement fallback, real camera/library inputs, screen readers, visual quality, performance or browser memory on the two phones.
* **Complete backup/restore:** the helper's crypto works locally; a full authenticated export, all-parts verifier, schema validation, idempotent restore, image checksums and recovery drill still require the implemented Phase 6 tools. The crypto vector is not an importable full-wardrobe fixture.
* **Dependencies and deployment:** no production lockfile, complete transitive inventory, provider account, email delivery or deployment configuration exists. Phase 0 resolves exact compatible dependencies and records maintenance/licence evidence. Dated provider allowances are in `11-COST-AND-HOSTING.md`.

No skipped item above is a release pass. These limits do not block completion of the requested blueprint; they are explicit gates for building the app.

## Reproducing the package checks

Validation-only tools used: Node **24.19.0**, Python **3.12.13**, Pillow **12.3.0**, PGlite **0.5.8**, Playwright **1.62.1**, Mermaid **11.17.2** and Chromium **149.0.7827.0** from `@sparticuz/chromium` **149.0.0**. None is a new approved application runtime dependency. No browser binaries or `node_modules` are included in the archive.

Run from the directory containing `blueprint/` after installing the validation tools separately:

```bash
python3 blueprint/validation/check-package.py
node blueprint/validation/check-backup.mjs
node blueprint/validation/check-localization.mjs
PGLITE_MODULE=/absolute/path/to/pglite/dist/index.js node blueprint/validation/check-sql.mjs
python3 blueprint/validation/generate-image-fixtures.py /absolute/temporary/image-fixtures
PLAYWRIGHT_MODULE=/absolute/path/to/playwright/index.mjs MERMAID_DIST=/absolute/path/to/mermaid/dist CHROMIUM_EXECUTABLE=/absolute/path/to/chromium node blueprint/validation/check-browser.mjs /absolute/temporary/image-fixtures
node --check blueprint/validation/security-sessions.mjs
```

`PGLITE_MODULE` and `PLAYWRIGHT_MODULE` can be omitted when those packages are resolvable normally. An optional `CHROMIUM_PACKAGE` path supplies serverless Chromium launch arguments if required. The browser prototype serves only local Mermaid files on a loopback ephemeral port. Initial standard-browser download attempts failed in this environment; a packaged Chromium binary was used for the recorded successful run. No access-control policy or provider configuration was weakened.

For live tests, copy `security-sessions.mjs` and its `fixture.jpg` together into the target repository. Set the normal-user variables in `13-REPOSITORY-STRUCTURE.md` through local private configuration. Setup may use a separate administrator fixture; the access-test process must not inherit that secret. Read `12-TEST-STRATEGY.md` for the complete feature matrix.

## Final consistency corrections

The final review removed all account connections and sharing from the original brief; assigned every requirement's test to an issue; separated decision IDs from deferred-trip requirement IDs; corrected accent contrast; added server retirement times and restorable feedback item IDs; and accounted for both base64 layers in encrypted backup disk estimates. The recommended first prompt contains all major Phase 0 architecture choices and tells Copilot to report any unavailable integration gate honestly.

Revision 1.1 adds R27, independent account language preferences, the English/Finnish/Swedish catalog and formatting helpers, the additive schema upgrade, backup compatibility rules and updated implementation prompts. Language work introduces no account relationship, provider call or new runtime dependency. Unchanged browser-image and backup-crypto results remain the previously executed checks; they were not rerun for this language revision.

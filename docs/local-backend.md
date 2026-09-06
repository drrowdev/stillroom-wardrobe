# Disposable local backend

## Implemented scope and current evidence

The local tools use the pinned Supabase CLI **2.116.0**, Node 24 and Docker. They do not install Docker, create cloud resources, link projects, use a management API, or reset remote databases. Host `psql` is not needed: the isolated provisioning process uses `docker exec` into the specifically labelled local database container, connecting to that container's own loopback Postgres endpoint with stock local trust authentication. It refuses password prompting.

The initial migration is a byte-for-byte copy of `blueprint/07-DATABASE-AND-RLS.sql`, revision 1.1, including its transaction. SHA-256:

```text
4f2d44603707cb823527c80d8384c2a6390f99ead2ba294435db83403a7eead5
```

Supabase retains management of the Auth and Storage schemas. No stubs, embedded database, additional migration, AI endpoint or paid generation is substituted for them.

**This environment has no Docker installation/daemon. Real Auth, Storage, migration execution, generated database types, security and integration passes are blocked, not completed.** Unit tests cover safety guards and refusal paths only. No placeholder `database.types.ts` is generated.

Local verification: **32 backend unit tests passed**, scoped ESLint passed, backend unit TypeScript checks passed, and all owned `.mjs` files passed `node --check`. Installed CLI version/command help were inspected; its status command failed on missing Docker with no reported configuration parsing error. `start`, `reset`, `types`, and `types --check` each returned exit 2 / `NOT RUN`. Real-test commands also returned exit 2 for missing consent/credentials. These are refusal-path results, not live authorization evidence.

## First local run

Install/start Docker separately, using a local Unix socket or Docker Desktop Windows named pipe. Ensure ports 54320–54322 are free. Docker contexts pointing to SSH/TCP daemons and `DOCKER_HOST`/`DOCKER_CONTEXT` overrides are deliberately refused. Use the Docker CLI's selected local context.

On Windows, use `npm.cmd` if PowerShell script execution blocks `npm.ps1`:

```powershell
npm.cmd ci
npm.cmd run db:start
npm.cmd run db:reset
npm.cmd run db:types
$env:ALLOW_SECURITY_TESTS = '1'
npm.cmd run test:integration
npm.cmd run test:security
npm.cmd run db:types -- --check
npm.cmd run dev
Remove-Item Env:\ALLOW_SECURITY_TESTS
```

On Linux/macOS:

```sh
npm ci
npm run db:start
npm run db:reset
npm run db:types
ALLOW_SECURITY_TESTS=1 npm run test:integration
ALLOW_SECURITY_TESTS=1 npm run test:security
npm run db:types -- --check
npm run dev
```

`db:start` launches the actual local services, checks the known database container, and verifies a healthy Auth HTTP response. Initial Docker image downloads can take several minutes. CLI output is captured rather than printed because startup/status can include credentials.

`db:reset` is destructive **only to the disposable local stack**. It checks Docker locality and the database container's exact name, Supabase project label, Postgres image and running state. It invokes `db reset --local --no-seed`, never `--linked`, `--db-url` or `--project-ref`; extra arguments are rejected. A changed initial migration hash also aborts the reset.

After successful migration, a separate Node process runs `scripts/provision-test-users.mjs`:

1. Read CLI status JSON into setup-only memory, never console output.
2. Through local container `psql`, reserve two independent fictional approval slots using `scripts/reserve-accounts.sql`. Refuse unexpected existing identities. No password is passed in SQL, a process argument or a command log.
3. Generate independent random 32-byte passwords and save the local credential cache **before** Auth creation, so an interrupted fixture can be resumed.
4. Create each missing confirmed Auth account once with the SDK admin API. Already-created accounts are verified normally; passwords are never silently rotated.
5. Verify each owner's profile with normal password login, then sign out. This is labelled setup verification, not the security access suite.

To retry interrupted provisioning without wiping data:

```powershell
node .\scripts\provision-test-users.mjs
```

Fixtures use `user-a@example.test` and `user-b@example.test` exclusively. Credential cache: ignored `.supabase/test-users.json`, mode 0600 where supported, parent directory mode 0700. Windows mode bits do not replace ACLs: keep this folder restricted to your user. Never publish/cache/upload this directory in CI. The file contains only fictional login credentials and public configuration, not a service key. If existing identities have no valid matching cache, provisioning refuses; reset this disposable stack rather than modifying unknown account credentials.

Provisioning creates `.env.local` **only if absent**, with the public URL/key and app version. It never writes passwords/admin keys there and preserves every existing file. If existing public configuration is different, review it manually; no remote config is silently replaced. The expected frontend URL is `http://127.0.0.1:54321`. Retrieve local login credentials from the private cache in your editor/password manager, not by dumping them into logs.

## Security/integration execution

Both commands require explicit `ALLOW_SECURITY_TESTS=1`. Without complete local credentials or a healthy local Auth service, they return **exit 2 / NOT RUN**, never a skipped pass. Assertion/cleanup failures return nonzero. The wrapper itself performs no CLI status or privileged requests.

By default the wrapper reads the fixture cache. Alternatively supply the complete set `SUPABASE_URL`, `SUPABASE_PUBLISHABLE_KEY`, `TEST_A_EMAIL`, `TEST_A_PASSWORD`, `TEST_B_EMAIL`, `TEST_B_PASSWORD` through a private process environment; partial explicit configuration does not fall back to another identity. No CLI password arguments or dotenv secret auto-loading exist.

The child process receives only those six settings, `ALLOW_SECURITY_TESTS`, and a short OS-runtime allowlist. Administrator/database credential variables are refused; `GH_TOKEN`, `GITHUB_TOKEN`, unrelated tokens, `NODE_OPTIONS`, cloud credentials and service keys are not inherited. Both harnesses independently validate configuration, even when invoked directly. Remote overrides do not exist; only literal loopback HTTP origins on port 54321 are accepted, and authenticated fetches refuse redirects.

* `tests/security/rls.sessions.mjs`: adapted supplied normal-session harness and original synthetic JPEG. Real A/B/anonymous Auth/REST/Storage calls cover private tables in both directions, owner override/FK/RPC rejection, no profile directory, independent Finnish/Swedish preferences, export ownership, foreign Storage download/sign/list/upload/delete, and disabled public/anonymous signup. Owners verify unchanged values and file hashes.
* `tests/integration/local.sessions.mjs`: distinct real normal-session checks for schema/profile access, explicit item creation, duplicate IDs, stale versions, image reservations and authoritative paths, incomplete commits, JPEG upload/hash retries, no overwrite, owner listing/signing, idempotent commit, interrupted replacement, and atomic outfit RPC retries.
* Both clean up only generated fixture IDs through normal owner sessions; security restores each previous language with version checks. No bulk privileged cleanup runs inside assertions. Do not run suites concurrently against the same fixture accounts.

This Phase 0 harness does not claim physical-device behavior, account-freeze orchestration, paid inference, full recovery or deletion Edge Function coverage. Those remain later phase gates.

## Actual database type generation

`npm run db:types` requires the real running local container and invokes the pinned CLI `gen types typescript --local --schema public`. Only successful plausible generator output is atomically written to `src/data/database.types.ts`. `--check` compares the exact output, including line endings, and fails on a missing or differing file. Nothing is hand-generated from the SQL and failures never replace a previous file.

While Docker remains unavailable, explicitly named Phase 0 frontend projections/runtime guards are not a substitute for full generated schema types. Run and review actual generation before declaring Phase 0 complete.

A Docker-capable Ubuntu CI runner can execute the same real-stack commands. Its first type-generation run must use `npm run db:types`; `--check` intentionally fails until the generated file is present. If retrieving generation from CI, upload **only** `src/data/database.types.ts`, never `.supabase`, `.env.local`, CLI status output, test credentials or session state. An artifact alone is not an integration pass: retain the actual job outcomes separately. Subsequent CI runs can use `--check` against the reviewed committed file.

## Targeted local validation

```powershell
npm.cmd run test:unit -- tests/unit/local-backend.test.ts
node .\scripts\db.mjs start
node .\scripts\db.mjs reset
node .\scripts\db.mjs types --check
```

The last three commands correctly report `NOT RUN` and nonzero status without Docker. Do not reinterpret that refusal as a passing live backend test.

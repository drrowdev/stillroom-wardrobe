# GitHub Copilot cloud development

Development continues in GitHub-hosted Copilot sessions against
`drrowdev/stillroom-wardrobe`. Source is public; account credentials, photos,
backups and local service state must never be published.

## Prepared environment

`.github/workflows/copilot-setup-steps.yml` contains the required single
`copilot-setup-steps` job on a standard Ubuntu runner. It installs pinned Node 24,
locked npm dependencies and Chromium, then starts disposable local Supabase,
applies the exact base migration, provisions fictional accounts and generates
real database types. Docker images are downloaded during setup, before the
agent's normal network restrictions take effect.

No production Supabase project, paid AI endpoint, larger runner, firewall
disablement or user-supplied production secret is required. The future hosted
Supabase region remains Stockholm (`eu-north-1`).

Setup failures are not passes: Copilot may still start in a partially prepared
environment. First inspect its setup log and `git status`, then confirm the
local stack with `npm run db:start` rather than assuming services survived.
Do not reset a useful in-progress fixture unless recovery requires it.

The generated `src/data/database.types.ts` can initially be untracked. Review
and commit it deliberately; never sweep `.env.local`, `.supabase`, browser
state, test results or logs into a commit. These are ignored. The test wrapper
passes ordinary fictional credentials to its child processes and strips
privileged/GitHub credentials.

## First cloud task: finish Phase 0

The initial push is **work in progress**, not a completed Phase 0 release.
Read `docs/phase-0-result.md`, the root agent instructions and the blueprint.

Known handoff work:

1. Fix the two recorded browser failures in `slice.spec.ts`: the cross-tab
   test attempts a second sign-in after the SDK may already have synchronized
   that session; the account indicator sits outside an accessible landmark.
   Determine which behavior is intended and fix the implementation/test
   contract without weakening cross-tab logout or accessibility assertions.
2. Run the real local Supabase integration and ordinary-user security suites.
   Fix genuine configuration/implementation defects; never replace these
   gates with browser fixtures or privileged access assertions.
3. Review generated database types and wire the client to the actual schema,
   replacing the explicitly temporary Phase 0 database projection as needed.
   Commit the generated file so the existing CI generation gate can pass.
4. Run the complete available quality/browser suite, inspect responsive
   capture/sign-in/wardrobe screens, and update Phase 0 evidence honestly.
   Chromium mobile emulation is not a real iPhone/Safari review.

```sh
npm run db:start
ALLOW_SECURITY_TESTS=1 npm run test:integration
ALLOW_SECURITY_TESTS=1 npm run test:security
npm run db:types
npm run lint
npm run typecheck
npm run check:translations
npm run test:unit
npm run test:browser
npm run build
npm run scan:secrets
npm run check:dependencies
npm run db:types -- --check
```

If the ephemeral canary is absent in a later CI process, generate a new random
build-only `STILLROOM_SECRET_CANARY` without printing its value before build
and scan. It is a leak-detection fixture, never a production credential.

## Delivery rules

Use a feature branch and pull request, not direct pushes to `main`. Do not
auto-merge. Finish Phase 0 only; do not start Phase 1, AI tagging, outfits,
calendar, production provisioning or paid services in the same task.

Each later phase is a separately scoped cloud task after its predecessor's
exit evidence is reviewed. Keep the photo-first, editable draft and explicit
Save contract, three languages, isolated owners and deterministic outfits.

The setup workflow must be on the default branch before it can prepare cloud
agent sessions. It also supports a manual Actions run for setup diagnostics.
Cloud agent availability and usage are governed by the account's GitHub
Copilot settings and plan; no completion is implied merely by configuring
this file.

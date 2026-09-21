# Azure garment pilot (P2-PILOT)

This isolated, operator-only I29/R28 evaluation helper supports **one prepared
photo, with no retries**: the original pair has at most two sends, and a separately
authorized single run has one selected-arm intent maximum. It does not
integrate Azure into the application, change Google 3.8 or its receipts, or
constitute the blueprint 20/21 thirty-photo comparison. This unblinded functional
pilot establishes neither a winner nor 90% accuracy, provider retention, a token
upper bound or a billing ceiling.

Authority: [reviewed pilot](https://github.com/drrowdev/stillroom-wardrobe/pull/27#issuecomment-5751331121)
and [conditional source release/model attestation](https://github.com/drrowdev/stillroom-wardrobe/pull/27#issuecomment-5751394575).
Those records do not reopen PR #27's deferred cleanup source. Source review and
owner-specific execution gates remain separate from passing offline tests.
The [A1 proposal](https://github.com/drrowdev/stillroom-wardrobe/pull/28#issuecomment-5752258564)
and [reviewed A1 source release](https://github.com/drrowdev/stillroom-wardrobe/pull/28#issuecomment-5752310646)
authorize bounded metering diagnostics and private unaccepted candidates for
future observations, not another live request or continuation of a halted pilot.
The [A2 proposal](https://github.com/drrowdev/stillroom-wardrobe/pull/28#issuecomment-5756648995),
[critique dispositions](https://github.com/drrowdev/stillroom-wardrobe/pull/28#issuecomment-5756769191)
and [selected owner decision/source release](https://github.com/drrowdev/stillroom-wardrobe/pull/28#issuecomment-5756899024)
added explicit single mode and private metadata-shape capture. The
[A4 plan](https://github.com/drrowdev/stillroom-wardrobe/pull/28#issuecomment-5758323341),
[F1-F6 critique dispositions](https://github.com/drrowdev/stillroom-wardrobe/pull/28#issuecomment-5758380283)
and [owner-approved source release](https://github.com/drrowdev/stillroom-wardrobe/pull/28#issuecomment-5758408874)
replace extension rejection with required-counter parsing and retire **new**
name/type capture. Historical records are unchanged. Source capability
is not permission to initialize or send: exact-head source/CI gates and the final
reviewed owner procedure remain required.

## Cost decision and limits

The user accepted an **EUR5 operational stop budget based on estimates**, not a
guaranteed invoice cap. Before each send the ledger consumes one fixed EUR2.50
allocation. Nothing refunds/recycles this allocation, including failed or
uncertain sends. Estimated per-arm cost is approximately EUR0.039 Terra and
EUR0.070 Sol under the reviewed assumptions, not EUR2.50 per expected call.
Unbounded provider overruns are not known to fit the reservation.

8192 input tokens is an estimate/anomaly threshold, **not an API-enforced cap**.
The request asks for at most 2048 completion tokens including hidden reasoning.
Actual input above 8192, completion above 2048, missing/inconsistent usage,
unexpected cache/model/control observations, or network/persistence uncertainty
halts further sends. A timeout does not cancel Azure processing or erase charges.
No paid retries, price research loop or support ticket is part of this helper.

Status reports observed usage and an upward-rounded **USD estimate** in integer
microUSD, not confirmed billing or EUR conversion. It applies the reviewed
short-context Standard DataZone rates of USD2.20/13.20 input/output per million
for Terra and USD4.40/22.00 for Sol. Thinking is already included in output and
is not charged twice by the estimate. Nonzero cache reads/writes halt rather than
silently applying discounts. Invalid/missing required metering may leave the estimate
unavailable; actual billing can remain unknown. There is no VAT assumption.
Unknown future billing-relevant extensions are ignored, not recorded or
estimated, and may go unnoticed by this helper. The estimate uses only reported
required input/output totals and reviewed rates; it is not a complete bill.
Provider alerts, 20K TPM/20 RPM deployment limits and the monthly Visual Studio
benefit spending limit do not enforce this EUR5 pilot budget. Credit is dev/test
only; no cash, Marketplace, production, add-ons or benefit changes are approved.

## Owner-only readiness

The implementation worker and CI must never receive the key, photo, approval
file, private ledger or identifying results. The owner must separately approve:

- The exact resource endpoint and both deployments: `stillroom-ai-eval`,
  `eval-terra-20260709` and `eval-sol-20260709`, configured July 9, 2026,
  DataZoneStandard EUR, NoAutoUpgrade. Existing portal observations are not
  inference tests. This helper pins the resource's
  `https://stillroom-ai-eval.openai.azure.com/openai/v1/chat/completions`
  endpoint. If that is not the owner's approved endpoint, stop; do not substitute
  another host or edit the URL to make it work.
- A locally decoded/reencoded, sanitized JPEG, no larger than 512000 bytes or
  1600 pixels per side, with no EXIF/GPS/trailing bytes. Check identifying pixels
  as well as metadata. Both models receive those exact prepared bytes. No raw
  original, label side-channel, account/history/location data or extra photo.
- The Azure privacy notice and private-input transfer. Azure-hosted OpenAI
  inputs are not provided to OpenAI or used for training without permission.
  The approved EU DataZone route is distinct from merely locating the resource
  in Sweden. Flagged content may be retained for abuse review; no zero-retention
  approval exists. `store:false` and cache controls do not prove zero retention.
- The estimated-budget risk, one invocation per arm, and private local storage
  with suitable OS permissions. Use a local, nonsynced directory outside **all**
  repositories and agent session folders. Do not use a network filesystem.
- Private process-scoped credential handling and live invocation by the owner.
  The API key grants resource-scoped data-plane access, not just one deployment.
  Resource-group membership is not a security boundary or an ARM management
  grant. Other processes with sufficient access (potentially the same user)
  can read process environment data. The helper starts no children.

The helper checks file size/hash and owner-declared dimensions; it is **not a
JPEG decoder, sanitizer or metadata validator**. Independently approved
preparation evidence and the owner's pixel review are indispensable. Do not
reinterpret a manifest checkbox as technical proof or use this tool to prepare
an original. No codec or existing held fixture implementation is used here.

Use Node **24.19.0**, matching `.node-version`, through an approved absolute
executable if necessary. No install, package restoration, Azure CLI, SDK,
account integration, credential discovery, signing library or global
configuration is needed. Do not change repository pins.

## Private preparation and invocations

The following are **owner-only instructions for after execution approval**,
not commands for the implementation worker. Choose one stable private pilot
directory and retain it across invocations; never create a second ledger to
evade a consumed slot. The directory must already exist with owner-only access.
Unix file modes are requested, but they do not establish Windows ACL privacy.

Create a private approval JSON file outside repositories/agent folders. Its
shape is below; replace the path, hash, byte count and dimensions with the
approved prepared file's actual values. All approvals must genuinely be true.
No credential belongs in this file.

```json
{
  "policy": "p2-pilot-1",
  "endpoint": "https://stillroom-ai-eval.openai.azure.com/openai/v1/chat/completions",
  "photo": {
    "path": "C:\\PRIVATE-OWNER-DIRECTORY\\prepared.jpg",
    "sha256": "REPLACE_WITH_64_LOWERCASE_HEX_DIGEST",
    "bytes": 0,
    "width": 0,
    "height": 0
  },
  "approvals": {
    "privateLocalDirectory": true,
    "preparedPhotoAndPixels": true,
    "azurePrivacyNotice": true,
    "resourceAndDeployments": true,
    "operationalBudgetRisk": true,
    "ownerOnlyExecution": true
  }
}
```

Here `node` means the approved exact pinned executable; use the full helper path
when running from the private directory. No image/key is passed on the command
line. The positional paths below are placeholders, not a suggested repository
or agent artifact location.

```text
node scripts\ai-evaluation\azure-garments.mjs init <absolute-private-pilot-directory> <absolute-private-approval-json>
node scripts\ai-evaluation\azure-garments.mjs status <absolute-private-pilot-directory>
node scripts\ai-evaluation\azure-garments.mjs send <absolute-private-pilot-directory> terra
```

Only `send` reads the dedicated `STILLROOM_AZURE_PILOT_KEY` process environment
entry. The owner obtains/supplies it privately through a separately approved
mechanism; never paste it into chat, code, command arguments, shell history or a
persistent environment file. Do not copy generated portal code/headers into
the repository. Use a clean process without preloads, debugger, TLS key logging
or HTTP tracing. The CLI refuses extra Node arguments and listed preload,
debugging and TLS override environment settings, but cannot undo code that ran
before startup. Clear the private process credential after use.

Initialization writes the immutable approval/control binding. It sends nothing.
Status prints only coarse outcomes, configured snapshot, returned model
identifier, observed usage, latency, reservations (`reservationCentsEur`, also
used in intent records), USD estimates (`estimatedMicroUsd`) and a result
review token. **Validated garment facts are stored only in private
`pilot.jsonl`**, not stdout. The owner may inspect them locally. Do not share
that ledger or even coarse request metadata without reviewing its privacy.

Terra runs first. Before the second invocation the owner reviews the private
facts and first status: identity, usage including reasoning/cache writes, fixed
request controls, privacy and budget risk. A family-only returned identifier is
recorded separately from configured July09; it does not verify snapshot equality.
Only the expected family identifier, its July09-qualified identifier, or the
current arm's exact fixed deployment alias is accepted. The returned value is
kept verbatim; an alias does not certify snapshot mapping. Other-arm and arbitrary
aliases halt. Missing usage details are not assumed zero.
The review token binds the second invocation to that first recorded result; it
is not proof a human read it.

```text
node scripts\ai-evaluation\azure-garments.mjs send <absolute-private-pilot-directory> sol <first-result-review-token>
```

There is no loop, autonomous second call, reset, retry, repair, fallback or
uncertainty-recovery command. Normal metered refusal/truncation/filtering is a
recorded failure and can be reviewed before a separate second-arm invocation;
it is not retried. An anomaly or uncertain intent blocks the second arm.
Identical inputs/settings are mandatory. Do not coach one model after reading
the other's result.

Explicit abandonment records unused slots as `NOT_ATTEMPTED` without refunding
or deleting earlier intent/uncertainty:

```text
node scripts\ai-evaluation\azure-garments.mjs abandon <absolute-private-pilot-directory>
```

## Separately authorized single observation (A2)

This is a new, independently approved one-shot run, not a way to resume, reset,
replace or migrate a halted pair. The historical A2 operation selected **Sol only**
with private name/type capture and the same prepared photo. The owner selected
an additional 250 EUR-cent allocation, bringing the aggregate allocation to
750 cents while retaining the prior 500-cent commitments. These are operational
allocations, not measured charges or an invoice ceiling. Nothing is refunded
because another run halted. No actual initialization or send is authorized by
this source document.

`init-single` consumes a private JSON object with exactly `approval` and
`authorization`. `approval` is the exact existing photo-approval object above,
with owner affirmations and unchanged prepared bytes. `authorization` has exactly:

```json
{
  "mode": "single",
  "selectedArm": "sol",
  "authorizationRef": "PUBLIC_APPROVAL_LABEL",
  "priorCommittedCentsEur": 500,
  "aggregateLimitCentsEur": 750,
  "shapeCapture": "private-names-types-v1"
}
```

Use the actual non-private public authorization label, not a URL, token or
credential. Its bounded identifier syntax authenticates nothing. The source
supports only `terra` and `sol`; this does not authorize another Terra call.
`shapeCapture` must still explicitly be `off` or `private-names-types-v1` for
binding/read compatibility; omission is invalid. **Neither choice produces new
capture under A4.** The example preserves the historical wire shape, not a new
capture instruction. There is no allowance field, `maxIntents` or consent flag.
The fixed reservation is 250 cents, and safe nonnegative integer accounting must
satisfy `priorCommittedCentsEur + 250 <= aggregateLimitCentsEur`.
Prior commitments are operator-attested, not automatically reconciled. Preserve
unknown exposure rather than entering zero. The helper does not enforce an
aggregate across copied directories, external requests or rewritten journals.

The following grammar/examples are for a later reviewed owner procedure only,
not an instruction or permission to execute now. The private input contains the
two objects above; no key or photo bytes belong in arguments:

```text
node scripts\ai-evaluation\azure-garments.mjs init-single <absolute-private-single-directory> <absolute-private-input-json>
node scripts\ai-evaluation\azure-garments.mjs send <absolute-private-single-directory> sol
node scripts\ai-evaluation\azure-garments.mjs status <absolute-private-single-directory>
```

The immutable single init record has exactly `type`, `approval`, `controls`,
`authorization`, `runBinding`, `time`. The wire field is **`controls`**, not
`controlsDigest`. The domain-separated binding covers authorization, approval
and unchanged controls; each single intent includes that `runBinding`. It
detects inconsistent associations, not malicious rewriting or duplication.
Legacy `init` keeps its original header and pair rules. An existing journal is
never overwritten or converted.

Inside the exclusive lock, single sends require the bound arm, no review token
and both slots still empty. A persisted intent exhausts the run regardless of
response, failure or uncertainty. An outer CLI read never authorizes mode or
dispatch. Pair Sol still requires its prior reviewed Terra result; single Sol
requires no fake Terra record or token. The opposite single arm is `NOT_PLANNED`;
an abandoned unused selected arm is `NOT_ATTEMPTED`. Single status reports no
review token (null), and only the public authorization label/mode and explicitly
operator-attested accounting. Old pair tokens remain unchanged.

### Historical private usage-shape capture (no new capture)

The owner approved retiring fresh capture in A4. New results never name or
capture unconsumed usage extensions. Every fresh single result has
`usageShape: null`, unconditionally set before persistence and return, including
failures and results under the legacy `private-names-types-v1` choice. Pair
results keep their original shape. Future diagnostic capture requires a
separately reviewed packet and fresh privacy consent; this enum is not authority
to collect new metadata.

Historical A2 records remain readable without rewriting bytes, hashes, bindings,
HALTs, null costs or reservations. Their capture eligibility required the bound
`private-names-types-v1` choice, `USAGE/UNEXPECTED_KEY` and an A1-qualified
unaccepted candidate. That diagnostic is no longer emitted by fresh parsing.
No historical extension is retrospectively accepted or declared harmless.
Only the private ledger may hold these historical `usageShape` values:

```text
null
{status:"CAPTURED", entries:[{name:<bounded name>, type:<fixed type>}]}
{status:"SUPPRESSED", entries:[]}
```

Only unknown own top-level usage-key names and the fixed types `null`, `boolean`,
`number`, `string`, `array`, `object` were captured. No values, nested keys,
lengths, headers, error bodies or full responses. Names are inert array entries,
never assigned as object properties. At most eight unique names are retained,
each matching `[A-Za-z_][A-Za-z0-9_]*` and at most 48 ASCII bytes, with a 1024-byte
serialized shape cap. The old producer suppressed the whole shape on any violation: no truncation,
prefixes, hashes, omitted counts or detailed suppression reason. Eight maximum
48-byte names with the longest type label serialize to 649 bytes; the 1024-byte
limit is defensive, not reached by a valid shape.

The old execution boundary suppressed the whole capture when a name literally
contained the active key (case-sensitive), using the identical empty SUPPRESSED
shape without a special log, reason or flag. This was **not anonymization**:
other secrets, personal content or differently encoded/cased text could still
occur in names. Syntax/length checks do not prove privacy or historical
authenticity. Fresh-null enforcement replaces that now-unused capture check;
it proves only that this channel emits no new names, not that no sensitive data
could exist elsewhere. Parsers remain credential-free.

Status emits only scalar `captureStatus` (`CAPTURED`, `SUPPRESSED` or null), never
names, types, entries or shape objects. SUPPRESSED reveals one bit, not zero
information. Do not export or disclose captures to agents, chat or PRs. New
single observations have exactly eleven keys, including the always-null
`usageShape`; pair observations remain legacy eight or A1 ten keys. Replay validates
the mode, bound arm, consent choice and strict shape/observation combinations.

Private names must be retained for **no more than seven days from capture/result
completion**, not from delayed scoring. Unresolved accounting does not justify
keeping names indefinitely; any accounting exception is limited to necessary
non-sensitive numeric/financial evidence. Reconcile preservation and cleanup
through the existing owner approval boundary. No automatic deletion, journal
rewrite, cleanup framework or new deletion authority is added.

## Request, persistence and failure boundaries

The request is one fresh v1 Chat Completion, one high-detail inline JPEG,
nonstreaming, LOW reasoning, 2048 total generated tokens, strict supported Azure
JSON Schema, `store:false`, and explicit cache mode without breakpoints. No
tools, web search, Files, history, redirects or retries. Response consumption
is limited to 262144 bytes and 30 seconds. Omitted provider control echoes do
not prove the provider honored a setting; contradictory echoes halt.

Preserve all 14 canonical facts: ten observed and material/seasons/formality/
style estimates. Unknown scalars are null, unknown arrays empty, and zero is
known. Unclear outcomes assert nothing. Brand/size require readability; image
text is data, not instructions. Separate domain validation enforces bounds,
unique collections and an 8192-byte facts limit. No Google envelope/receipt is
relaxed. This is not a production Save or library entry.

The fixed private ledger is append-only under an exclusively created lock
directory. A flushed dispatch intent consumes EUR2.50 **before** the sender
runs. A crash at this point may consume a slot without any actual request.
Intent, confirmed complete response and unused slot are distinct. The tool
never labels two planned slots as two actual calls. Results retain safe usage/
identity observations, validated facts and coarse failure reasons, never raw
image/base64/key/request/error bodies or reasoning content.
A completed HTTP response with an invalid envelope retains its safe HTTP status
and response-received observation while remaining halted with its full
reservation. Receipt does not establish valid inference, usage or charges.

File `sync()` is requested before dispatch and after recording results. This
depends on the OS, local filesystem, hardware and directory-entry durability;
it is not an unconditional power-loss guarantee. Do not use concurrent external
editors or delete/copy/truncate ledger files. Torn, missing, changed or oversized
state fails closed. A leftover lock is never automatically expired: stop and
retain evidence. A write error may leave durable intent without a result even
when a response was received; do not repeat the send.
Write/sync/close uncertainty retains the lock even if a complete-looking result
is visible in the file. Visible bytes do not prove successful durable recording.
If lock cleanup also fails after a primary validation error, both safe codes are
reported (for example, `PHOTO_CHANGED; LOCK_RELEASE_FAILED`), never raw errors
or paths. The remaining lock still blocks another invocation; no cleanup
recovery is authorized.

### Required-counter compatibility and invalid metering

[Microsoft's v1 lifecycle guidance](https://learn.microsoft.com/en-us/azure/foundry/openai/api-version-lifecycle)
allows new response objects and recommends parsing only those required.
The public [completion-usage model](https://github.com/openai/openai-python/blob/main/src/openai/types/completion_usage.py)
documents text/image/audio/reasoning/cache/prediction breakdowns; the
[SDK extension guidance](https://github.com/openai/openai-python#undocumented-response-properties)
supports extra response properties. These public contracts do not establish the
meaning of any private extension or exact deployed-Azure behavior.

The helper still requires the usage and both detail objects, plus all six own
counters: `prompt_tokens`, `completion_tokens`, `total_tokens`,
`reasoning_tokens`, `cached_tokens` and `cache_write_tokens`. SDK optionality
does not relax these requirements. Every counter must be a nonnegative safe
integer; input plus output must be safe and equal total, reasoning cannot exceed
output, and cached tokens cannot exceed input. Input/output ceilings and
required zero cache reads/writes remain unchanged. Missing is never zero.

Extra top-level usage fields and unconsumed detail fields are ignored, regardless
of name, type or value. Optional prompt `text_tokens`/`image_tokens` and completion
`text_tokens` are not validated, added to totals or retained. There is no invented
breakdown reconciliation, sum requirement or double-counting. Unknown does not
mean harmless, zero, free or financially understood.

The only additional detail assertions are `audio_tokens` in both detail objects
and `accepted_prediction_tokens`/`rejected_prediction_tokens` in completion
details: if present, each must be exactly zero or null. Other values halt with
`UNEXPECTED_COMPONENT`. These are **name-bound assertions**, not universal
unsupported-capability detection; different future names are ignored. Required
counter failures retain precedence. All model/control/answer gates still apply.

New pair and single observations include `usageDiagnostic` and `unacceptedCandidate`; both keys
are always present. `usageDiagnostic` is null except for `USAGE_INVALID`, where
it contains one fixed `{field, condition}` pair identifying the first failed
check. It does not report every failure or imply later checks passed.

| Field | Allowed conditions |
| --- | --- |
| `USAGE` | `MISSING`, `NOT_OBJECT`; historical-only `UNEXPECTED_KEY` |
| `PROMPT_DETAILS`, `COMPLETION_DETAILS` | `MISSING`, `NOT_OBJECT`, `UNEXPECTED_COMPONENT` |
| `INPUT`, `OUTPUT`, `CACHE_WRITE` | `MISSING`, `NOT_NONNEGATIVE_SAFE_INTEGER` |
| `TOTAL` | `MISSING`, `NOT_NONNEGATIVE_SAFE_INTEGER`, `SUM_UNSAFE`, `TOTAL_MISMATCH` |
| `REASONING` | `MISSING`, `NOT_NONNEGATIVE_SAFE_INTEGER`, `REASONING_EXCEEDS_OUTPUT` |
| `CACHE_READ` | `MISSING`, `NOT_NONNEGATIVE_SAFE_INTEGER`, `CACHE_READ_EXCEEDS_INPUT` |

Checks proceed through the usage/detail containers, input/output/total/reasoning/
cache-read/cache-write counters, arithmetic relationships, then the named
audio/prediction assertions. `MISSING` means the
property is absent, not that its value is null or malformed. Neither case is
treated as zero. Unexpected provider keys/values are never copied into this
diagnostic; only the fixed container and condition are retained. Historical
`UNEXPECTED_KEY`/`UNEXPECTED_COMPONENT` diagnostics and their read-side
eligibility remain valid without reinterpretation; new unknown extensions
produce neither diagnostic nor capture. No partial
counter dump, raw response, error text or invented cost is recorded.

Invalid usage **always remains `HALTED / USAGE_INVALID`**, even when another
answer gate fails. Accepted `facts`, normalized `usage` and `estimatedMicroUsd`
remain null. The reservation is held and the next send remains blocked.

Only when all independent answer gates pass may the private ledger retain
`unacceptedCandidate: {status: "UNACCEPTED_METERING", facts: ...}`. These gates
require completed HTTP 200, bounded JSON/UTF-8, current-arm identity, unchanged
control/tool/audio checks, one index-0 assistant choice, no refusal, a stop
finish, bounded content and the existing exact schema/domain rules. Refusal,
truncation, filtering, invalid identity/controls/content or transport failure
cannot produce a candidate. The candidate is **not a successful or accepted
receipt, an application draft, accuracy evidence or permission to continue**.

An independently valid nonnegative safe-integer input/output counter above
8192/2048, or a nonzero required cache counter, also suppresses the candidate,
even if another usage field is invalid. Unknown/malformed counters do not prove
compliance, supply zero defaults or override a separately demonstrated breach.
Even entirely absent usage can coexist with an independently validated candidate;
that says nothing about metering compliance, costs or billing.

Only the existing private ledger holds candidate facts, under the same access
and retention rules. Status exposes the fixed diagnostic and a scalar
`candidateStatus` (`UNACCEPTED_METERING` or null), never the candidate object or
facts. No raw-response capture, export or candidate-to-application path exists.

Legacy eight-key observations remain readable as stored, without added fields,
rewritten bytes or changed review-token hashes. A1 pair observations require both
extension keys and strict valid combinations; partial extensions are rejected.
Legacy status shows unavailable diagnostic/candidate information as null. Policy,
request controls and their digest binding are unchanged. Existing halted ledgers
remain halted: there is no migration, reset, recovery or second-arm release.
**A generic historical error cannot reveal its rejected field or recover an
already discarded answer.** Do not infer a missing cache-write counter merely
from `USAGE_INVALID`.

This is cooperative single-owner accounting, not tamper resistance against
an owner resetting files or using the resource key elsewhere. Local abort/
timeout is not provider quiescence. Keep uncertain reservations held; neither
status nor abandonment performs an Azure query, cancels inference or releases
charges. A generic local I/O failure must not be treated as permission to reset.

## Offline validation and interpretation

The only targeted checks for this packet, using the exact pinned executable:

```text
node --check scripts\ai-evaluation\azure-garments.mjs
node --check scripts\ai-evaluation\azure-garments.test.mjs
node --test scripts\ai-evaluation\azure-garments.test.mjs
```

Tests use synthetic text (not JPEGs), fake senders and owned temporary ledgers.
They do not read real credentials, decode photos, contact Azure, execute old
runners or establish production privacy/billing behavior. No third-party
packages are required. Native HTTPS and owner preparation remain live external
gates. The import has no network/file/environment-read side effects.
Synthetic compatibility checks freeze the pre-A1 controls digest and legacy
HALTED review token and verify unchanged journal bytes after read/status and a
blocked send. Candidate tests measure the complete serialized result record and
journal under the unchanged bounds, including wrapper/diagnostic overhead; an
unaccepted-candidate record is not assumed smaller than a SUCCESS record.
A2 tests additionally freeze an A1 pair token and exercise single-mode bindings
and one-intent/accounting/CLI constraints. A4 freezes synthetic captured/suppressed
result bytes produced with the unchanged committed A2 helper, with
[pre-refactor provenance and digests](https://github.com/drrowdev/stillroom-wardrobe/pull/28#issuecomment-5758425825).
The new fixture-generation tests are distinguished from that historical helper.
Replay tests preserve those bytes, strict shape rejection and consumed slots.
Old extension-rejection/capture-production assertions intentionally become
extension-invariance, no-new-capture and historical replay assertions. Required
counter, named audio/prediction, cache, bounds and other safety tests remain;
synthetic key-bearing names must not enter new results, ledgers or summaries.
These fixtures do not represent or reconstruct actual operator records.

Report actual attempts, failures and unused slots separately. Schema, transport,
truncation and refusal failures are not invented semantic labels. Inspect useful
unknowns, unsupported claims and correction burden without a winner claim.
Two resolved responses only complete this pilot's collection, not accuracy,
blinding, billing reconciliation or original I29 acceptance.

## Retention and cleanup

Keep private evidence only for the owner-approved retention period; the earlier
proposal was seven days after scoring/abandonment for evaluation copies/results,
with nonidentifying accounting retained for reconciliation. Do not erase needed
uncertainty evidence or original photos. Removing local copies or Azure resources
does not guarantee deletion of provider abuse-monitoring data.
For A2 captured names, the stricter seven-day maximum from result completion
above controls; the accounting exception never extends private-name retention.

On completion or abandonment, reconcile dispatched/uncertain charges, then seek
fresh user confirmation and inspect exact current membership before deleting
`rg-stillroom-ai-eval` or its resources through the owner-approved portal.
No resource deletion, key rotation/revocation or original-photo deletion is
performed by this helper. If credentials/resources are retained, any portal key
rotation/revocation needs explicit owner approval; do not rotate automatically
just before deleting. No unrelated resources, IAM, benefit or application
settings are changed.

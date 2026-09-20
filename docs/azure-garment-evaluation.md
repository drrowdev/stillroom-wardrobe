# Azure garment pilot (P2-PILOT)

This isolated, operator-only I29/R28 evaluation helper supports **one prepared
photo, once per approved model, at most two sends, with no retries**. It does not
integrate Azure into the application, change Google 3.8 or its receipts, or
constitute the blueprint 20/21 thirty-photo comparison. This unblinded functional
pilot establishes neither a winner nor 90% accuracy, provider retention, a token
upper bound or a billing ceiling.

Authority: [reviewed pilot](https://github.com/drrowdev/stillroom-wardrobe/pull/27#issuecomment-5751331121)
and [conditional source release/model attestation](https://github.com/drrowdev/stillroom-wardrobe/pull/27#issuecomment-5751394575).
Those records do not reopen PR #27's deferred cleanup source. Source review and
owner-specific execution gates remain separate from passing offline tests.

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
silently applying discounts. Unexpected/missing metering may leave the estimate
unavailable; actual billing can remain unknown. There is no VAT assumption.
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

On completion or abandonment, reconcile dispatched/uncertain charges, then seek
fresh user confirmation and inspect exact current membership before deleting
`rg-stillroom-ai-eval` or its resources through the owner-approved portal.
No resource deletion, key rotation/revocation or original-photo deletion is
performed by this helper. If credentials/resources are retained, any portal key
rotation/revocation needs explicit owner approval; do not rotate automatically
just before deleting. No unrelated resources, IAM, benefit or application
settings are changed.

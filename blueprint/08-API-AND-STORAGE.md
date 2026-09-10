# API and private storage contracts

Use generated Supabase TypeScript database types from committed migrations, including the planned I29 AI extension before its features ship. Domain adapters convert SQL snake_case into UI camelCase. Every operation below uses the current user's session unless explicitly marked server-only. An explicit owner filter improves clarity and export safety; **RLS remains the security boundary**. No operation names, accepts or reveals a second user.

Revision 1.3 adds photo-first pre-save analysis in `20`. The base API remains; I29 adds authenticated draft analysis, checked Save/provenance, description editing and exports. Analysis creates no item/image; image commit never triggers AI. The supplied SQL does not yet implement these additions.

## Common contract types

```ts
type UUID = string;
type UiLanguage = 'en' | 'fi' | 'sv'; // profiles.ui_language is null until first owner choice
type ISODate = string; // YYYY-MM-DD, validated as a real calendar date
type ImageVariant = 'main' | 'thumb';
type AppError = {
  code: 'INVALID_INPUT' | 'UNAUTHENTICATED' | 'NOT_AVAILABLE' |
        'CONFLICT' | 'UPLOAD_INCOMPLETE' | 'QUOTA_REACHED' |
        'UPSTREAM_UNAVAILABLE' | 'UNSUPPORTED_IMAGE' | 'INCOMPLETE_EXPORT';
  message: string; // allowlisted UI copy; never raw upstream body
  requestId: UUID;
  retryable: boolean;
  field?: string;
};
type Result<T> = { ok: true; data: T } | { ok: false; error: AppError };
type PreparedImage = {
  main: Blob; thumb: Blob; mainSha256: string; thumbSha256: string;
  width: number; height: number; altText: string;
};
type ImageRequest = { imageId: UUID; variant: ImageVariant };
type SaveOutfit = {
  id: UUID; expectedVersion: number | null; title: string; occasion: string;
  notes: string; favourite: boolean; itemIds: UUID[];
};
type SaveWear = {
  id: UUID; expectedVersion: number | null; localDate: ISODate;
  timezone: string; state: 'planned' | 'worn'; label: string;
  outfitId: UUID | null; itemIds: UUID[];
};
```

The SQL column constraints are the validation maxima. Add runtime parsers at boundaries using small explicit type guards; TypeScript types alone do not validate network/file data. UUIDs, real dates, finite numbers, string lengths and enumerations must be checked.

## Operations

REST below means `/rest/v1/…` with the publishable key and user bearer token. Query only explicitly needed columns. Private original tables never use “owner OR household” filters.

| Operation | Contract and response | Error/retry behaviour |
|---|---|---|
| Sign in/out | SDK `signInWithPassword`, `signOut`; validate membership by fetching own profile | Generic sign-in failure; no email enumeration. One refresh attempt on expired token. |
| Profile/preferences | SELECT own singleton; PATCH allowed fields with `owner_id` and `version` predicates, returning updated row | Zero returned rows → conflict/unavailable; reload, do not overwrite silently. |
| UI language | PATCH own profile `{ui_language:'en'|'fi'|'sv'}` with current version; null is only an unset initial/import value | Use saved-owner/sign-in/browser/English precedence; a failed save does not claim persistence. No other profile or locale is queried; see `19`. |
| Item create | Only after explicit Save: checked create with fixed draft values, client-generated ID and owned analysis provenance where available | Required title/category are checked here, not before analysis. Retry identical Save without another AI call. Hide incomplete image saves from completed inventory. |
| Item list/search | Owner-scoped compact metadata, stable `(created_at,id)` cursor; local search/filter; 40 visible thumbnails/page | Abort stale searches; only owned results in the wardrobe. Retry read up to twice. |
| Item edit/trash/restore | PATCH `id`, `owner_id`, expected `version`; set fields or `deleted_at`; return row | 409-style conflict on zero-row version match. Trash affects only the current owner. |
| Permanent item removal | Confirm, remove owned image objects, forget metadata, DELETE own item; resume remaining keys on failure | Do not claim success if bytes remain. A second DELETE of already absent content succeeds logically. |
| Image reserve | INSERT permitted `item_images` columns; state defaults pending; paths are generated in DB | Reuse reservation UUID only for identical prepared hashes. Incomplete reservation is recoverable. |
| Image upload | SDK Storage `.upload(path,blob,{contentType:'image/jpeg',upsert:false,cacheControl:'0'})` | 409 existing object → authenticated download and compare SHA-256; equal means success, unequal means conflict. |
| Commit/retire/forget image | RPC `commit_image(p_image_id)` / `retire_image(p_image_id)` / `forget_image(p_image_id)` → void | Incomplete upload → keep old ready version; retiring an imported version leaves the active photo unchanged; existing object bytes block forgetting. |
| Outfit save | RPC `save_outfit(p_id,p_title,p_occasion,p_notes,p_favourite,p_item_ids,p_expected_version)` → version | Atomic parent + ordered links; same create payload/ID is idempotent; stale version fails. |
| Calendar save | RPC `save_wear_event(p_id,p_local_date,p_timezone,p_state,p_label,p_outfit_id,p_item_ids,p_expected_version)` → version | Atomic event/links; preserves unchanged history snapshots. Future worn date fails. |
| Calendar date/state only | Version-checked PATCH of the event | Retains historical null-link items. Delete/trash and undo operate on the owner event. |
| Statistics | SELECT owner events/links/items; reduce in browser using rules in `06` | Empty is valid. Never request an administrator aggregate. |
| Feedback | Own item flags; INSERT canonical `combination_rules`; upsert own `suggestion_feedback` with `item_ids`, vote and owner by `(owner_id,signature)` conflict target | SQL validates each item owner, sorts IDs and derives the signature; duplicate identical rule is success. |
| Export snapshot | RPC `export_manifest(p_export_id)` → versioned JSON metadata snapshot | Single statement for consistent metadata; null for no membership; failed image download makes full export incomplete. |
| Delete own account | POST `/functions/v1/delete-account` with `{confirmation:'DELETE',reauthPassword:string}` → 204 or `{status:'pending'}` | TLS only; never log body. Function derives owner, reauthenticates, then drives server-only deletion control. |
| AI consent/status | Checked owner-only settings/result/status/allowance operations | No direct private request/usage tables, peer totals or provider keys. Withdrawn consent blocks new analysis/results. |
| Analyze draft photo | POST `/functions/v1/analyze-clothing` with user token, request UUID, draft generation and bounded sanitized JPEG bytes -> validated attributes/image hash/status | No saved-item/owner target or external URL. No inventory writes. Identical request replay returns existing result/status; conflicting hash/config is an error. |
| Discard analysis | Owner-only discard operation removes bounded result; retain only necessary coarse charge receipt | No item/image deletion needed before Save because none was created. Cannot recall already-sent provider data/charges. |
| Save/edit description | RPC `update_image_description(p_image_id,p_expected_description_version,p_alt_text)` → one typed row with `id,owner_id,item_id,alt_text,description_version`; new-image Save stores edited text at reservation | Expected-counter write changes text/counter only; intentional `''` clears. No image re-upload, path/hash/byte mutation or unrestricted image UPDATE. |

`deletion_control(p_owner_id,p_action,p_code)` is server-only, never granted to normal/anonymous users. The deletion endpoint derives the verified owner. The separate analysis endpoint is callable by an approved user with consent/budget, not anonymously or with only a publishable key; its provider credentials and private receipt operations remain server-only.

### I29b saved-description source contract

Stage 1 adds local migration source only; fresh database CI, actual generated types
and the separately authorized Stage 2 editor remain pending. It does not authorize
hosted application or deployment. The exact SQL signature is:

```sql
public.update_image_description(
  p_image_id uuid, p_expected_description_version bigint, p_alt_text text
) returns table(id uuid, owner_id uuid, item_id uuid, alt_text text, description_version bigint)
```

The RPC is VOLATILE SECURITY DEFINER with an empty search path, fully qualified
relations, current `private.is_approved()` and ownership derived from `auth.uid()`.
Only authenticated callers receive EXECUTE; PUBLIC/anon have none. No owner,
path/hash/byte/state argument, table UPDATE/DELETE grant or counter INSERT grant
is added. Null image ID/counter/text, counters outside 1–2147483647, and text above
240 PostgreSQL characters fail with `22023` / fixed `Invalid input`. Empty text
is preserved, never replaced with the title. SQL does not trim/translate text.

One conditional UPDATE sets only `alt_text` and `description_version+1`, matching
the image ID, owner, ready state, null retirement, exact expected counter below
2147483647 and existence of an owned non-deleted parent item. Every matched call
advances the counter, including same-value text. Stale equal text is not
idempotent success. Zero affected rows always fails: an unlocked owned/current
lookup may classify a counter mismatch/ceiling as `22023` / `Request conflict`;
foreign, absent, pending, retired or deleted-parent targets give `42501` /
`Not available`, as does missing admission. No raw upstream error is UI copy.

There is no parent row lock. Existing `commit_image` locks the pending image,
then parent, then old ready image; taking an old-ready-to-parent lock here would
create a deadlock cycle. PostgreSQL rechecks the updated target image's state and
counter after a concurrent row change; the parent EXISTS is statement-snapshot
evidence, not a promise to observe a later soft delete. Same-counter concurrent
edits have at most one success; replacement can retire the target but cannot
redirect the edit to the new image. Item version/provenance, all other image
columns, history and actual object bytes are unchanged. No analysis, upload,
commit or restore call is triggered.

The Stage 2 client must validate exactly one returned row, owned image/item
identity, attempted text and baseline counter + 1 before accepting success.
Name/category and description have independent explicit Saves and dirty
baselines; saving one preserves the sibling draft. A lost/ambiguous response
retains a frozen NOT CONFIRMED attempt and offers an explicit read-only check,
never an automatic write/rebase. Description reconciliation requires the same
owned image, exact attempted text and exact baseline counter + 1. Equal text
alone or a later counter cannot confirm it. This confirms current stored state,
not exactly-once request identity. Definitive rejection remains rejection.

## I29c manual field Save contract

The shared capture/saved form reviews all thirty item fields. Only explicit Save
allocates item/image IDs and freezes deep copies of the validated fields, manual
intent/provenance and exact description, with immutable prepared Blob references
and owner/epoch. Repeated submit events share a synchronous latch. Retry reuses
that snapshot and those IDs; no new photo analysis, automatic retry or new
baseline is inferred.

Creation inserts only manually supplied/cleared user/revision-1 assertions;
untouched factual assertions are omitted, never unknown/revision-0 entries.
Duplicate item reconciliation requires owned identity, no deletion, initial row
version 1, every frozen field and semantic provenance equality. Creation does
not compare generated timestamps. Image reconciliation checks identity, parent,
dimensions, sizes, hashes and the frozen caption, including `''`. Pending images
also require description counter 1. An unchanged-caption ready image may have a
later counter; changed captions conflict rather than being overwritten or
reported as the frozen reviewed value. Storage transport and commit are unchanged.

Saved editing performs one owner/id/non-deleted/expected-version PATCH per item
Save, coupling every changed factual value with user/previous+1. Same-value manual
confirmation of an unverified value and explicit empty clears include both value
and assertion; unchanged already-user values are no-ops. The six app settings
have no provenance entries. No focus, language formatting or Save click alone
confirms facts. Description Save remains separate and preserves the item draft.
Uncertain item replies require exact next version, intended values/revisions and
all untouched provenance/system facts, including original `created_at`, in an
explicit read-only confirmation; no automatic second write or rebase.

Optional blank text maps to null; notes and description clear to `''`. Prices
retain canonical decimal meaning and their raw input's entry locale; the numeric
SDK conversion must have a finite bounded two-decimal round trip. Formatting never
supplies storage values or converts currency. Real date-only input uses UTC-only
presentation. Historical values/collections remain unchanged unless edited.
Future restore must retain empty collections and manual provenance, rebind owned
IDs and reserve exact saved description text without inference or imported consent.
AI receipts/allowances/expiry and final saved-only export remain unfinished I29
work; this source contract authorizes no hosted migration or deployment.

## PR #17 checked manual Save source candidate

The staged migration `20260910070000_checked_item_save.sql` adds:

* `reserve_item_save(p_item jsonb,p_image jsonb)` returns one row containing
  `item`, `image`, `fingerprint`, `state`. The closed item input contains `id`,
  all thirty garment fields and manual `field_provenance`; the closed image
  input contains `id`, main/thumb byte lengths and SHA-256 metadata, width,
  height and exact `alt_text`. Owner, versions, paths, state and times are
  server-controlled. Only explicit user/revision-1 provenance is accepted.
  Atomic reservation claims both used identities and creates all live rows or
  rolls everything back. Canonical typed price/provenance semantics and JSON
  key ordering do not create distinct intents.
* `finalize_item_save(p_item_id uuid,p_image_id uuid,p_fingerprint text)` returns
  void. Current admission/owner, the live attempt, exact fields/provenance,
  item version 1/nondeletion, original image metadata/caption, description
  version 1/nonretirement and both actual canonical Storage object records
  are required. First completion atomically commits the image and records server
  completion; completed replay repeats those checks, including object presence.
  No ready-only or identifier-marker-only success is valid.
* `commit_image` retains the legacy implementation in a non-client-callable
  private helper. The public wrapper rejects either an owner-local used item ID
  or used image ID, including alternate images and raw recreation after deletion.
  Genuine legacy IDs/grants remain usable. Future checked replacement/restore
  needs its later reviewed route, not this legacy shortcut.

New paths lock the enabled owner's profile first. Attempt/image/item and object
locks fail closed with NOWAIT; a two-second lock timeout also bounds uniqueness/
FK waits. Existing delete cascades, retire and description paths remain unchanged;
their reverse ordering is not assumed safe merely from a diagram. Normal-session
race tests must execute before acceptance. A specific lock conflict rolls back
the whole call. Errors are closed `22023` / `Invalid input`, `Request conflict`,
`Upload incomplete`, or `42501` / `Not available`, never raw field/peer details.

Stage 1 is source only because the native database reset failed in the unchanged
base migration. The current client still uses the earlier flow above. Stage 2
must connect **every** manual AddItem Save after actual generated types and a
fresh verified receipt; preserve its frozen values/IDs/owner epoch, explicit
Retry/Discard, existing translated errors and byte-identical `ensureFile`,
thumb-before-main upload order/options and duplicate-object SHA comparison.
No analysis call, byte attestation, paid activation, completed I29 or hosted
change follows from this metadata/object-presence prerequisite.

## Authenticated image access

Owner views use `storage.from('wardrobe').download(path)` through the current user's SDK client, with a custom fetch adapter setting `cache:'no-store'` for data/storage/auth requests. Convert returned JPEG bytes to a Blob URL and revoke it on unmount/logout/account change. Coalesce identical in-flight `(ownerUid,imageId,variant)` downloads and cap concurrency at four. No Edge media function, public image endpoint or sharing URL is implemented. RLS checks current approved-account status and the reserved owner path on every new Storage request.

Never persist private images in Cache Storage, IndexedDB or the service worker. An owner may keep already loaded images in memory during a temporarily disconnected session, visibly marked stale. New access still requires an authenticated owner. Already delivered bytes cannot be remotely recalled; logout clears application-held bytes and aborts late responses.

## Complete image flow

| Step | Implementation contract |
|---|---|
| 1. Select | Separate camera and library controls. Cancellation is not an error. Keep the original Blob in memory only. |
| 2. Validate | Accept decoded JPEG/PNG/WebP; treat MIME as a hint and inspect signatures. Reject SVG/HTML/animated formats, >20 MiB source, invalid image, or >40 megapixels before allocating a full canvas where header parsing permits. |
| 3. Decode/orient | Use a tested `createImageBitmap` path with orientation handling; fallback to a decoded HTMLImageElement. Test all eight orientations to avoid double rotation. Decode one image at a time and release resources. |
| 4. Crop | Accessible crop rectangle, fit/rotate/reset buttons, keyboard nudging and numeric aspect options. Do not require pinch or drag. Default preserves the full garment with a warm neutral background. |
| 5. Strip metadata | Draw only oriented/cropped pixels onto a new canvas. Do not copy JPEG APP/EXIF/XMP/IPTC chunks or original filenames. Re-encode output pixels. Reject the output if metadata test finds EXIF/GPS/XMP. |
| 6. Resize | Longest side ≤1,600 px, never upscale; preserve aspect ratio. Avoid retaining multiple full-size canvases on phones. |
| 7. Compress | JPEG quality 0.82 initially; iterate downward to 0.55. If still >500 KiB, reduce longest side by 15% and repeat to 800 px. If still too large, require a different crop/photo. Do not silently upload a larger file. |
| 8. Thumbnail | Create ≤320 px longest side, JPEG ≤60 KiB, target 25 KiB; derive from the same sanitized image. |
| 9. Background removal | Disabled provider for MVP. If later enabled, run locally on decoded pixels before final encoding, then pass through all byte/metadata checks again. |
| 10. Reserve/upload | Hash both outputs with SHA-256, insert image metadata, use generated paths and private uploads. Upload thumbnail and main with max two concurrent requests. |
| 11. Retry/deduplicate | Retry transport failures after 1/2/4 s plus jitter, max three tries. Same UUID + same hashes retries safely. Compare own ready-image main hashes for a possible duplicate and ask before adding; no cross-owner hash lookup. |
| 12. Commit/display | Call `commit_image` after both successful uploads. Owner views use authenticated Storage download into a Blob. |
| 13. Replace | New image UUID and files; atomically commit; retire prior image. Retain the prior version for the owner’s seven-day recovery window. |
| 14. Remove | Delete both owned objects with Storage API, then `forget_image`. Never manipulate Storage's metadata table instead of deleting bytes. |
| 15. Cleanup | Pending `created_at` >24 h, retired `retired_at` >7 days, and trash `deleted_at` >7 days are candidates. Cross-check current image metadata before deletion; operate only within the owning UID prefix. |
| 16. Export/restore | Export sanitized stored files, not camera originals. Verify bytes against manifest hashes. Restore with new owner-bound paths and the same validation; never trust archive paths. |

Before the persistent image flow reaches reserve/upload, I29 sends the prepared main JPEG inline for analysis and fills the draft. No library object is created for analysis alone. **Reserve/upload/commit starts only on explicit Save**, using the exact reviewed snapshot and generated immutable IDs. Incomplete saves remain hidden and retry without inference. Photo changes/manual edits invalidate stale analysis; late results never change saved items. Restore and image commit have no analysis side effect.

If the browser cannot decode a selected HEIC/HEIF photo, explain how to select/export a JPEG or take a compatible camera photo; do not add a server converter or upload the unsupported original. Compatibility with the actual iPhone photo-library conversion is a Phase 0/2 test. This limitation is visible before any failed save.

Paths: `wardrobe/{owner_uuid}/{item_uuid}/{image_uuid}/main.jpg` and `thumb.jpg`. All IDs come from UUID validation; no user filenames, email addresses or city names. Database-generated paths are authoritative. Ownership cannot change during replacement/restore.

### Signed URL policy

There is no share/link-generation feature. The app uses authenticated downloads. For a temporary operator diagnostic only, an owner-generated signed URL should request a 60-second lifetime and must not be logged or cached. An authorized owner can technically issue a longer bearer URL to their own file through the underlying Storage API; RLS does not impose that TTL. Assume such a deliberately issued URL remains usable until expiry unless the immutable object path is deleted/rotated. Signing out or freezing the account does not retroactively invalidate a previously minted bearer capability. New authenticated requests are blocked by the current approval state. Never promise revocation of downloaded copies.

## Export format and restore

The delivered **version-1 reference** uses encrypted, independently downloadable JSON parts, avoiding a large ZIP dependency or a 500 MB allocation on a phone. Metadata-only export is a plain `.json` download after an explicit “contains personal information” label. Full backups are encrypted by default and contain sanitized photos.

**Revised MVP compatibility:** metadata/part schema v2 covers saved attributes/provenance; Phase 6 reads v1/v2, keeping encryption envelope v1. Supplied references are not yet v2-capable. Verify original hashes before conversion. Exclude drafts, analysis requests/results and usage; never import active consent or trigger analysis. Remap source-image IDs, preserve clears and mark old provenance-less values unverified. V2 mapping uses `stillroom/restore/v2|targetUid|exportId|table|sourceId`; keep v1 mapping unchanged for v1 resumes.

I29b's `description_version` is included by the existing full-row `to_jsonb`
serialization in `export_manifest`; the RPC body is unchanged. The raw v2
snapshot still includes intermediate/pending/imageless records and is not the
completed saved-only export contract. A future restore must retain `alt_text`
exactly, including `''`, omit the source counter from reservation INSERT, and
start the new image's local description counter at 1. Do not import concurrency
history as an editable counter, fabricate provenance/consent or trigger inference.
No restore code or saved-only export implementation is part of Stage 1.

Each decrypted part is UTF-8 JSON:

```ts
type ExportPartV1 = {
  format: 'stillroom-export'; schemaVersion: 1; exportId: UUID;
  partIndex: number; partCount: number;
  manifestSha256: string;
  manifest?: { /* exact export_manifest result; present in part 0 */ };
  files: { imageId: UUID; variant: ImageVariant; sha256: string;
           byteLength: number; mime: 'image/jpeg'; base64: string }[];
};
```

Canonical manifest serialization sorts object keys lexicographically and table rows by their primary-key tuple; arrays representing ordered links stay ordered. Hash that exact UTF-8 serialization. Files are sorted by image UUID and then `main`,`thumb`; greedily form parts with **at most 12 MiB decoded file bytes** each. Photo base64 makes about 16 MiB plaintext; part 0 can add up to 8 MiB metadata, and the ciphertext's outer base64 makes about 32 MiB on disk in that worst case, plus JSON overhead. Reject any encrypted input part above 40 MiB before parsing. Part 0 may be metadata-only. V1 refuses metadata >8 MiB with an explicit unsupported-size error; both browser and reference CLI have this limit. Each intended wardrobe is expected below it; larger metadata needs a later versioned format, not silent truncation.

Encrypt each part with browser/Node Web Crypto: random 16-byte salt, PBKDF2-HMAC-SHA256 **600,000** iterations, 256-bit AES-GCM key, random 12-byte IV, 128-bit authentication tag. The envelope contains `{format:'stillroom-encrypted',version:1,kdf:'PBKDF2-SHA256',iterations:600000,salt,iv,aad,ciphertext}` with binary fields base64. `aad` is the exact UTF-8 string `stillroom:1:{exportId}:{partIndex}:{partCount}`. Each part uses a new salt/IV; never reuse them. Filename `stillroom-{exportId}-{partIndex}.json.enc`. Passphrase is not stored or sent to the server; recommend a password-manager-generated passphrase and explain that a lost passphrase cannot be recovered.

The CLI uses Node crypto/streams and the same format; it does not require a runtime package. File transfer within each part is sequential; multipart mobile downloads require a user action per part where browsers restrict automatic multiple downloads. Show total parts and confirm completion only after all files/hashes have been included. Wrong password, tampering, missing parts or deleted files is a failed/incomplete backup, not a successful export.

Restore order: decrypt and validate → dry-run summary → obtain current user UID → profile/preferences by explicit merge choice (default preserve current preferences) → items → images and commit → outfits/links → wear/events links → feedback/rules. Restore historical null-item wear snapshots through owner writes preserving their exported text only in the approved restore path; see the dedicated restore RPC requirement below. Exports contain only the current owner’s records. Restore never creates a user relationship or contacts another account.

For each restored image, reserve/upload normally, then call `commit_image` for the source ready version or `retire_image` for a source retired version. A full backup refuses pending versions. Restored retired versions get a fresh seven-day recovery window. Database-generated paths and image lifecycle timestamps are regenerated, not injected by an import; idempotent comparisons use mapped identity, intended state, hashes, dimensions and alt text. Recovery of a retired photo in normal use copies its stored bytes into a new version and commits that version.

Map IDs deterministically using the first 16 bytes of SHA-256 of `stillroom/restore/v1|targetUid|exportId|table|sourceId`, setting RFC UUID variant and version **8** bits. For tables without an ID, use the canonical primary-key tuple as sourceId. Recompute image paths from target owner and remapped IDs; reject any unrecognized table/column or foreign owner in the source snapshot. Rerun with the same export ID: equal existing content is skipped; differing content is a conflict requiring review, never an automatic overwrite. Reorder canonical pair UUIDs after mapping. The imported data remains distinguishable by this deterministic namespace without a separate import-jobs table.

Remap `suggestion_feedback.item_ids` and sort them before insertion. The database derives the new signature from those target IDs; do not restore the old signature literally. This preserves exact likes/dislikes after UUID remapping. A permanently deleted item removes feedback for combinations containing it, so an export cannot contain dangling feedback item IDs.

**Phase 6 restore operations:** the supplied `restore_history_entry(p_id,p_event_id,p_item_id,p_title,p_category,p_import_id)` RPC preserves exported text for both existing and permanently deleted item links. It accepts only the caller's event and optional owned item, bounded title/category, deterministic entry UUID and import ID. Ordinary INSERT cannot set `import_id`; ordinary history text is derived from the current owned item. Restore creates event parents with owner-scoped INSERT, then invokes this RPC for each snapshot. `save_outfit` accepts owned archived/trashed references for recovery; the ordinary outfit picker offers active items only and renders unavailable historical components explicitly. Both behaviours are intentional and covered by tests.

## General errors, cancellation and idempotency

### I29e source-only control RPCs

These seven `public` JSONB RPCs are not wired into the application. No endpoint,
provider configuration, photo transfer, paid work, checked Save or saved marker
is delivered here. `private` remains unexposed and has no client table policies
or grants. PUBLIC/anon execute is revoked for every new function; the four owner
methods grant authenticated execution and accept **no owner parameter**. Only
service_role can execute the three server methods. Its explicit owner parameter
must eventually come from a verified token, never a browser/model owner claim.

Money uses exact integer micro-USD, unrelated to garment currency. Input monetary
values are PostgreSQL bigint, 0–9223372036854775807 for known bills; NULL means
unknown. Policy limits must be positive bigint; summed accounting uses numeric
and is returned as decimal integer **text**, never rounded/clamped. Profile
versions likewise return decimal text. Returned JSON keys/codes are protocol
identifiers, not localized messages.

Every mutation obtains the existing profile FOR UPDATE first, captures a single
`clock_timestamp()` after waiting, then uses controls → ledger → full-request
order. That serializes the owner across UTC months, including deletion; no GUC,
invented role, current-month mutex or post-profile admission-row lock is used.
Admission uses a current statement snapshot of enabled approved-account state;
AI permission is checked under the owner lock. A concurrent freeze can follow
that observation; neither it nor withdrawal recalls already delivered content.
Consent UPDATE uses the existing version/timestamp trigger, while mere locks
do not update the profile. Result lifetime is original creation + configured TTL,
never renewed by completion. Dispatch and content recheck pinned model/prompt/
notice; operational limit changes do not rewrite old reserves/periods.

| RPC and exact parameters | JSON outcomes |
| --- | --- |
| `ai_status()` | On admission denial `{code:"UNAVAILABLE"}`. Otherwise `{code,period,serverTimeMs,consent,policy,usage}` as detailed below. Performs at most 100 owned expiry removals. |
| `ai_set_consent(p_enabled boolean,p_notice_revision integer,p_expected_version bigint)` | `{code:"OK",profileVersion:text}` on CAS success. Withdrawal requires null revision, clears consent and works without configuration. Enable needs current activated positive notice. Failures: `{code}` with INVALID_INPUT, UNAVAILABLE, CONFLICT, UNCONFIGURED, INACTIVE or CONSENT_REQUIRED; no mutation. |
| `ai_begin_request(p_request_id uuid,p_draft_id uuid,p_generation integer,p_image_sha256 text)` | `{code:"OK",status:"reserved"\|"dispatched"\|"ready",replayed:boolean}`; otherwise `{code}`: INVALID_INPUT, UNAVAILABLE, UNCONFIGURED, INACTIVE, CONSENT_REQUIRED, CONFLICT, TERMINAL, ACTIVE_DRAFT, RATE_LIMIT or ALLOWANCE. Does not validate image bytes, dispatch or write facts/inventory. |
| `ai_request_control(p_request_id uuid,p_action text)` | Action status/discard only. Live permitted status: `{code:"OK",status,result}` (result null until ready). Removed/expired/discarded: `{code:"TERMINAL",reason}`; reason DISCARDED, EXPIRED, FAILED, UNAVAILABLE or INVALID_FACTS. Otherwise `{code}`: INVALID_INPUT, UNAVAILABLE, UNCONFIGURED, INACTIVE, CONSENT_REQUIRED or CONFIG_CHANGED. Foreign/missing both UNAVAILABLE. Discard needs admission/ownership, not AI consent/config. |
| `ai_mark_dispatched(p_owner_id uuid,p_request_id uuid)` | `{code,claimed:boolean}`. Only the live eligible reserved → dispatched transition returns OK/true. False codes: UNAVAILABLE, TERMINAL, EXPIRED, UNCONFIGURED, INACTIVE, CONSENT_REQUIRED, CONFIG_CHANGED, ALREADY_CLAIMED. No insertion or second claim, including lost acknowledgement. |
| `ai_settle_request(p_owner_id uuid,p_request_id uuid,p_facts jsonb,p_billed_micro bigint,p_code text)` | Input code SUCCESS, FAILED or BILLING_ONLY. Early denial `{code,stored:false}`: UNAVAILABLE, INVALID_INPUT, BILLING_CONFLICT. After accounting `{code,stored,chargeState,accountedMicro:text,undispatchedCharge:boolean}`. Codes READY, TERMINAL, EXPIRED, BILLING_ONLY, FAILED, NOT_DISPATCHED, UNAVAILABLE, INVALID_FACTS, FACTS_CONFLICT; only READY stores facts. |
| `ai_purge_expired(p_limit integer)` | Limit 1–1000, otherwise `{code:"INVALID_INPUT"}`. `{code:"OK",removed:integer}` counts total full rows deleted, not owners. Profile locks use SKIP LOCKED; no media/profile modification. |

`ai_status` uses code OK/UNCONFIGURED/INACTIVE/CONSENT_REQUIRED. `period` is
server UTC `YYYY-MM`; `serverTimeMs` is integer epoch milliseconds.
`consent` is `{enabled,noticeRevision,consentedAt,profileVersion}`; unset
revision/time are null. `policy` is null when unconfigured, otherwise
`{activated,noticeRevision,modelId,promptVersion,maxRequestMicro,
monthlyAllowanceMicro,maxRequestsPerHour,resultTtlSeconds}`.
`usage` is `{accountedMicro,requestsLastHour,warning}`. Accounted admission cost
includes current-period settled amounts **and all outstanding reserved/held
maxima across periods**. Warning is true at ≥80% of positive allowance.
Hourly counts include every admitted request, even released ones.

UUID/draft IDs use the shared UUID shape; generation/prompt/notice are positive
int32; image hash is 64 lowercase hex; model is 1–128 ASCII `[A-Za-z0-9._:/-]`.
Begin looks up the owned UUID ledger before admission limits. Exact full-context
replay checks draft/generation/hash/current pinned model/prompt/notice and costs
nothing; conflicting reuse denies. A tombstone is terminal, never a fresh
reservation. New admissions check active draft, rate, then allowance with fixed
distinct reasons and no partial ledger insertion. Bounded cleanup may remove up
to 100 old owned full rows first; it never refunds a known/dispatched charge.

Settlement first reconciles known bills, even after withdrawal or removal.
Known equal bills are idempotent, different bills conflict, and NULL does not
overwrite known accounting. Unknown dispatched failures remain held; only
persisted never-dispatched evidence allows release. A late known charge without
dispatch evidence sets `undispatchedCharge:true`, records the bill and confers
no content/dispatch authority. Billing-only never recreates context. Rejected
content does not roll back a known bill; facts cannot overwrite different ready
facts. A live result arriving after billing-only can store under the original
dispatch/permission/config/expiry guards without charging twice.

Ready `result` has exactly the I29d AiResult fields: `schemaVersion:1`,
`requestId,draftId,generation,imageSha256,modelId,promptVersion,createdAtMs,
expiresAtMs,facts`. Milliseconds use floor(epoch × 1000) from the preserved
timestamps. Facts have exactly `{outcome:"ready"|"unclear",fields:{...}}`;
the ten observed/four estimated fields and vocabulary/code-point/numeric/list
bounds match `parseAiFacts`. Missing/null/empty arrays remain unknown; integer
zero is known. Extra/private/system/confidence fields and asserted unclear
facts are rejected. Facts and the full envelope are each at most 8192 UTF-8
bytes (SQL JSONB representation); no provider body is stored.

Explicit expiry/status cleanup and purge delete full context, retaining only
the minimal ledger. This packet installs no scheduler and makes **no inactive
account physical-retention guarantee**. Paid/private-photo activation remains
blocked on separately reviewed scheduled purge and operator approvals.
`export_manifest` stays SQL/STABLE/SECURITY INVOKER/empty-search-path/schema v2,
excluding only the three new profile consent fields. Saved-only export and
legacy imageless/failed-Save ambiguity are still open.

Map allowlisted `AppError.code` values to localized messages; never display raw SQL/HTTP errors in any language. Keep protocol values such as deletion confirmation `DELETE`, RPC names, stable codes, filenames and JSON keys unchanged. `19-LOCALIZATION.md` defines the optional v1 profile export field `ui_language` and safe import of older backups without it; hashes are verified before normalization.

PostgREST may return 200 with an empty array for a denied SELECT/UPDATE/DELETE; tests must assert absence and unchanged owner data, not only HTTP status. Normalize raw SQL errors before showing them. 401 → sign in; unauthorized/missing objects → same 404-style copy; stale edit → conflict; 413/unsupported → edit photo; 429 → bounded backoff; 5xx/network → retry with same UUID. No retry of password failures or confirmation-dependent deletion. Abort fetches when changing accounts; stale responses whose captured UID no longer matches the session are discarded.

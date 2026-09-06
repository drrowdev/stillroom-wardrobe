# Decisions, assumptions and setup inputs

**Governing change, 2026-09-05:** the user explicitly removed any connection between their account and their wife's account. This supersedes the original brief's household/sharing requirements. The final blueprint contains no relationship model, peer directory, recipient column, sharing grant, borrowing or shared recommendation input. Independent administrative admission of two logins is retained.

## Decision record

Implementation choices are proposed unless user-approved. On **2026-09-06**, the user allowed paid AI and chose deterministic outfits. The latest revision **1.3** requires photo-first automatic form filling, editing every garment field before Save, and explicit library saving. It replaces the earlier post-save tagging workflow. Provider activation is still a setup decision.

| Decision | Why it fits / simpler alternative | Cost and privacy consequences | Risk / test |
|---|---|---|---|
| ADR01 One PWA | Camera/library and daily private use suit a browser app. Expo/wrapper adds distribution work. | $0 hosting target; one codebase, no store account required. | Test installed/current iOS and Android; compare in `05`. |
| ADR02 Independent owner data | No household or user-to-user entity. Two administrative approval rows are invisible to users. | No discovery/connection surface or sharing function cost. | Assert absent relationship entities and A/B isolation on every operation. |
| ADR03 Supabase with one backend | RLS/Storage/Auth support independent accounts without custom auth. Separate projects would separate infrastructure too but double provisioning/migration operations. | Common operator/quotas, no exposed cross-user data. Not end-to-end encryption or separate infrastructure. | Normal-session RLS tests; explicit operator trust boundary in `10`. |
| ADR04 Auth admission trigger + disabled signup | Defence beyond a hidden signup button. Operator creates each account independently. | No SMTP dependency or public user enumeration. | Third-account and unauthorized-email tests; actual hosted signup configuration gate. |
| ADR05 Private immutable image paths | Client crop/JPEG encoding avoids image-processing bills. New UUID per replacement is simpler than cache invalidation for overwrites. | Sanitized photos only; no raw GPS; owner-authenticated requests. | Eight orientations, EXIF/GPS parser checks, private download/sign tests and interrupted replacement. |
| ADR06 Deterministic outfits - user selected | Rules use saved manual/AI clothing details, preferences and history. No AI stylist/reranker in the first release. | No model charge per outfit request; automatic photo tagging is separately billed. | Unknown attributes, hard constraints, owner isolation and ten-decision usefulness sample. |
| ADR07 Cloudflare Pages Free | Static shell needs no server host. Azure SWA Free is equivalent fallback if account management is preferred. | No Azure credits or paid Workers; private data stays in Supabase. | Build/deploy smoke check; recheck dated allowances before setup. |
| ADR08 Shell-only offline | Persistent private data would need device encryption/eviction/account-switch handling. | Less offline capability; no cross-account stale cache. | Offline route and cache inspection tests; explicit stale own-session UI. |
| ADR09 Snapshot wear history | Editing/deleting current inventory should not erase what was worn. A log referencing only live items would be simpler but lose history. | Small database overhead; all history still owner-only. | Permanent item deletion preserves null-link text; full account deletion removes it. |
| ADR10 Separate encrypted backups | Live free-tier storage has no included automatic backup. Native crypto/JSON parts avoid a ZIP dependency. | Local/off-device capacity required; passphrase loss is unrecoverable. | Checksums, wrong password, missing parts and quarterly restore drill. |
| ADR11 Optional weather | Rounded city input is enough; manual context is simpler and always available. | Noncommercial free calls; provider sees city/IP only after opt-in. | Consent off makes no call; timeout and stale forecast tests. |
| ADR12 No local segmentation initially | Model licence/download/memory work exceeds first-release value. Crop/neutral framing is useful immediately. | No runtime model/dependency or paid licence. | Future candidate has a separate phone benchmark and licence gate. |
| ADR13 One privileged deletion function | Auth user deletion cannot be delegated to browser secrets. Manual operator deletion is fallback, not normal UX. | Rare free Edge calls; derived owner ID and fresh reauth limit privilege. | Wrong-target attempts and interrupted job must preserve the other account exactly. |
| ADR14 Photo-first editable draft - user selected | AI fills title/category/details before explicit Save. `21` expands the model comparison: provisional Gemini 3.5 Flash-Lite, GPT-5.4 Mini/Luna challengers, other models conditional. | Eligibility and processing terms first; correction effort before small token-price differences. No automatic provider switch. | Model-specific garment evaluation; no source establishes an accuracy winner for this app. |
| ADR15 Request/response analysis - replaces worker | Authenticated endpoint returns draft fields; bounded receipts deduplicate retries. No background tagging or auto-save. | Server credentials, 24-hour result expiry and separate usage ledger; no inference queue/scheduler. | Late responses, manual clears, discard, expiry, freeze/deletion and budget races. |
| ADR16 Stockholm project region - user selected | Explicit Supabase North EU (Stockholm), `eu-north-1`, for the Helsinki-based users. No latency benchmark implied. | Primary project data region; Edge Functions and external AI are separately configured/disclosed. | Confirm specific-region availability during provisioning; never silently select generic Europe. |

## Explicit assumptions

* One common app deployment and Supabase project is acceptable **provided user profiles/data have no relationship and remain invisible to one another**. The instruction is interpreted as application/data separation, not a request for separate infrastructure accounts. Administrative operators remain trusted. This boundary is documented, not silently equated with end-to-end encryption.
* The operator is the user setting up the project; their normal application login is still unprivileged. Each person receives their own login through an existing secure channel, never through the other person's app.
* English, Finnish and Swedish are supported. Initial language follows the owner/sign-in/browser/English precedence in `19`; each account's saved preference is independent. Europe/Helsinki and EUR stay separate defaults. City weather is off. No body or health information is needed.
* Each account eventually has about 500 items and one main photo/thumbnail per item. The operator monitors total service usage; neither user sees the other's usage.
* Cloud costs are compared in USD before taxes/conversion. Prefer free infrastructure; paid automatic tagging is allowed with explicit limits. No personal Azure credit amount/expiry/type is assumed.
* Working name Stillroom Wardrobe is an internal private-app choice, not a trademark clearance or public commercial brand recommendation.
* Installed package patches/transitive dependencies are fixed during Phase 0, with an explicit inventory gate; current repository pages did not expose exact release freshness.
* HEIC conversion and actual phone memory behaviour remain implementation tests; JPEG fallback is the chosen baseline.

## Setup inputs and approvals

**Language decision, revision 1.1:** provide English/Finnish/Swedish through a static catalog and native formatting, with no new runtime dependency or provider fee. Finnish uses `fi-FI`, Swedish `sv-FI`, English `en-GB`. Native-speaker wording and actual UI layout remain release reviews, not unresolved architecture choices. Existing schema users apply the additive migration; no account relationship or shared language setting is introduced.

**Settled:** independent accounts, three languages, photo-first AI-filled editable draft, explicit Save, deterministic outfits. **Before paid activation:** provider eligibility/model quality/region/retention and finite allowance. Nothing has been configured or benchmarked yet.

Before deployment, supply the two independent login emails and service accounts, and select **Stockholm (`eu-north-1`)** for Supabase. Confirm function and AI processing regions separately. Each person chooses their password and backup passphrase/location. These are setup inputs; no live project has been created or moved here.

Optional later decisions require a new request: AI outfit reranking/chat, unrelated paid infrastructure upgrades, Azure credit usage, custom domains, native distribution, persistent private offline data, background segmentation or Phase 8 trips. Paid photo tagging itself is now in scope. User connections/sharing are **not** a planned later phase.

## Known validation limits

The SQL is checked in PostgreSQL with Supabase schema stubs and the authenticated role. Real Auth/REST/Storage assertions, browser rendering, the deletion function and physical-device tests require an implemented app/configured local stack. They are not reported as passed. The final report lists executed package checks separately from future release gates. No production app, cloud resource, invitation or GitHub issue has been created by this task.

Revision 1.3 changes the plan, not the base SQL or app. I29 owns the pre-save endpoint, receipts/provenance, form and description-edit controls; Phase 6 owns metadata-v2 recovery. Historical results do not demonstrate the new flow. This revision does not settle the separate empty-target-versus-merge restore decision.

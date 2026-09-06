# Cost and hosting

Target: **low running cost, with bounded paid AI tagging**. On 2026-09-06 the user clarified that $0 is not a hard limit and chose deterministic outfits, so there is no recurring AI outfit-generation charge. Infrastructure allowances below were researched on **2026-09-05**; AI prices on **2026-09-06**. Providers can change either. Dollar figures are USD before applicable taxes/currency conversion. No Azure credit dependency is assumed. Custom domains, Copilot subscriptions and existing devices/internet are separate costs.

## Verified allowances

All rows in this table are **CONFIRMED public provider statements**, not service guarantees.

| Provider | Relevant allowance | Source / accessed |
|---|---|---|
| Supabase Free | $0; 500 MB database; 1 GB files; 5 GB egress plus a separate 5 GB cached egress allowance; 50,000 MAU; 500,000 Edge invocations. Two active free projects maximum. | [Supabase pricing](https://supabase.com/pricing) · 2026-09-05 |
| Supabase Free operations | Pauses after one week of inactivity. Automatic backups/PITR and image transformations are not included. API/database log retention is one day. | [Supabase pricing](https://supabase.com/pricing) · 2026-09-05 |
| Supabase upgrade reference | Pro starts at $25/month. Paid plans introduce a billing commitment; spend caps do not make every billable feature free. | [Supabase pricing](https://supabase.com/pricing) · 2026-09-05 |
| Cloudflare Pages | Free entry tier, unlimited static requests/bandwidth, SSL; source states no credit card needed. This does not confer unlimited paid Workers/function resources. | [Cloudflare Pages](https://www.cloudflare.com/products/pages/) · 2026-09-05 |
| Azure Static Web Apps Free | 100 GB/month bandwidth; no bandwidth overage purchase; 250 MB/environment, 500 MB across environments; 3 preview environments, 2 custom domains, 10 apps/subscription. | [Microsoft quotas](https://learn.microsoft.com/en-us/azure/static-web-apps/quotas) · 2026-09-05; source updated 2024-05-30 |
| Open-Meteo Free | Noncommercial only; 600/minute, 5,000/hour, 10,000/day, 300,000/month; no reserved capacity guarantee. | [Open-Meteo pricing](https://open-meteo.com/en/pricing) · 2026-09-05 |

The cached and uncached Supabase allowances are **not** treated as one interchangeable 10 GB pool. Plan conservatively against the 5 GB uncached allowance; authenticated/no-store media may not benefit from cached egress. No unverified Azure Blob, Functions, OpenAI or credit entitlement is included. Exact Cloudflare build quotas were not exposed in the selected page and are not asserted here; forecast under 30 builds/month and verify the account's build allowance during setup.

## Expected storage

English/Finnish/Swedish support adds static text catalogs and a profile column. Native `Intl` and local lookup add no translation API or runtime model call. Automatic tagging has its own cost below; translated taxonomy/status labels stay static. Measure the expanded bundle against the existing limit.

These are **PROPOSED sizing assumptions**, not provider facts. `KiB=1,024 bytes`, `MiB=1,048,576 bytes`; provider GB figures are treated conservatively as decimal GB.

| Component | Calculation | Size |
|---|---|---:|
| Main photos | 1,000 items × 220 KiB average | 225.28 MB / 214.84 MiB |
| Thumbnails | 1,000 × 25 KiB average | 25.60 MB / 24.41 MiB |
| Current images total | One main + one thumbnail/item | **250.88 MB / 239.26 MiB** |
| Retired/pending/trash headroom | 15% of current images | 37.63 MB |
| Outfit previews | Browser CSS compositions; no stored bitmaps | 0 |
| Live target | Current images + temporary headroom | **288.51 MB** |
| Maximum encoded sizes scenario | 1,000 × (500 + 60) KiB, plus 15% | **659.46 MB** |
| Three encrypted backups per account, aggregate size | 3 × 250.88 MB × (4/3)² base64 overhead, plus 15% version headroom | Approximately 1.54 GB plus metadata, outside live Storage; reserve 2 GB, or 4 GB for the maximum-size scenario |

The maximum scenario assumes the client honours its byte limits. Bucket limits cap each object at 500 KiB, not the combined pair or declared thumbnail size. Measure actual object bytes for quotas. Uncollected retired versions can exceed 15%; warning logic must use real totals, not this estimate.

Database planning allowance: 1,000 items (~3 MB), images/outfits (~5 MB), five years of wear events/links plus indexes (~10–25 MB), and feedback/preferences (<2 MB). Reserve **100 MB total measured database size** including platform/system growth rather than claiming the user tables are the whole database. Actual measurement decides capacity. Two independent accounts use two MAU.

## Expected monthly traffic

| Activity | Assumption | Approximate uncached bytes |
|---|---|---:|
| Thumbnail browsing | 2 people × 30 days × 150 thumbnails/day × 25 KiB | 230.40 MB |
| Full views | 2 × 30 × 20 main photos/day × 220 KiB | 270.34 MB |
| Weekly full backups | 4.3 × 250.88 MB across the two separate exports | 1,078.78 MB |
| Metadata/API and extra owner browsing allowance | Conservative reserve for extra downloads and API responses | 220 MB |
| **Budget estimate** | No persistent private image caching | **~1.80 GB/month** |

The MVP uses full weekly backups; no incremental format is assumed. Encryption/base64 expansion happens locally and affects backup disk space, not the Storage download estimate. Mobile exports or repeated restore drills add traffic. Browser memory reuses already displayed thumbnails within one session; nothing here relies on persistent private-photo caching.

Revision 1.3 uses on-demand draft-analysis requests, result lookups and rare account deletion, not scheduled tagging-worker invocations. Prepared photos arrive inline before library Save, without a worker Storage download. Budget endpoint traffic and bounded result-receipt storage/cleanup. Weather stays approximately **240 forecast calls/month** plus city searches; static hosting never contains wardrobe photos.

## Paid AI allowance

The expanded current-model comparison is in `21-AI-MODEL-COMPARISON.md`; `20` defines the workflow. Primary candidates, USD per million tokens:

| Candidate / route | Input | Output, including billed reasoning |
|---|---:|---:|
| Gemini 3.5 Flash-Lite, paid Google Cloud global | $0.30 | $2.50 |
| Gemini 3.5 Flash-Lite, proposed Cloud EU multi-region | $0.33 | $2.75 |
| GPT-5.4 Mini, OpenAI global comparator | $0.75 | $4.50 |
| GPT-5.6 Luna, OpenAI global economy challenger | $0.20 | $1.20 |

Sources: [Google Cloud pricing](https://cloud.google.com/gemini-enterprise-agent-platform/generative-ai/pricing), [OpenAI pricing](https://developers.openai.com/api/docs/pricing), accessed 2026-09-06. European OpenAI image processing requires enhanced retention-control approval and a 10% premium. `21` also covers Mistral, Claude, Terra and newer Gemini, with separate eligibility/retention gates.

Normalized illustration: 1,000 analyses at 2,000 total input tokens (image + text) and 500 total billed output tokens each give **$1.85 Flash-Lite global / about $2.04 EU**, **$3.75 GPT-5.4 Mini global**, or **$1.00 Luna global**. `21` provides the full table. Equal token assumptions compare rates, not actual photographic tokenization or a measured cost per garment. Reasoning, retries, region premiums, discarded drafts and re-crops change costs. No batch/cache discount.

Do not select by cents alone: a few extra dollars for initial cataloging can be worthwhile if it avoids repeated user corrections. Gemini 3.8 Flash's current introductory rates end after 2026-12-31; forecast the published later rates rather than treating its temporary effective price as permanent. Confirm invoice/credit treatment in the selected Cloud product.

Analyze once per prepared draft photo where possible, deduplicate retries and never analyze every crop movement or field edit. The form fills before Save; only reviewed saved attributes feed local outfit rules. Saving, discarding, language changes, views and recommendation refreshes do not themselves make model calls. Explain that discard does not refund prior analysis. Restore never reanalyzes.

Before activation, approve a finite monthly allowance per account. Atomically reserve bounded request cost, warn at 80% and stop new calls at the allowance. Allow one active request per draft plus owner rate limits. Identical retries retrieve the existing status/result; unknown-billing timeouts must not automatically redispatch. Reconcile reservations conservatively. Provider alerts do not replace limits; accounts see only their own use.

## Charge controls and warning levels

| Resource | Warn | Action threshold | Action |
|---|---:|---:|---|
| Actual file storage | 600 MB | 800 MB; pause new uploads at 900 MB | Remove abandoned/expired versions after owner-visible review; recompress future images; export before deletion. Never remove current or recovery-required media blindly. |
| Database, including system size | 300 MB | 400 MB | Inspect table/index growth, remove expired feedback/deletion receipts, export; no automatic upgrade. |
| Uncached egress/month | 3 GB | 4 GB; conserve at 4.5 GB | Reduce repeated thumbnail fetches and postpone redundant exports; prioritize the scheduled weekly backup and urgent recovery downloads. Flag any missed backup against the seven-day recovery target. |
| Edge invocations/month | 100,000 | 400,000 | Investigate loops/abuse, pause the deletion endpoint while investigating and use operator-assisted deletion. |
| Cloudflare builds | 30/month internal budget | Account's verified free limit | Stop redundant builds; deploy from main only. No paid plan switch. |
| Weather | 240/month expected; flag >1,000/day | 5,000/day internal cap | Disable automatic refresh and use manual context; endpoint 429 triggers backoff. |

Quota values are read from provider dashboards by the operator weekly and recorded in a local operations checklist. Each account sees only its own image usage. The app cannot reveal the other account or aggregate usage, and cannot be trusted as the authoritative provider bill meter. Do not use a service secret to expose provider billing APIs to the browser. Application caps are cooperative controls for these independent accounts, not a guarantee against internet-level denial of service.

Prefer free infrastructure plans; approved AI billing is the explicit exception. A quota shortfall may stop service and must never trigger an app-initiated upgrade. Paid Supabase/Cloudflare, domains, SMTP, native distribution or Azure resources still need a separate decision. GitHub Actions should have a zero paid-spend budget and short artifact retention. Copilot is an implementation tool with its own subscription, not the app's AI tagging provider.

## Azure and provider exit

Azure Static Web Apps **Free** is a viable alternate static host without consuming credits; choose it only if the user prefers managing another resource in their existing Azure account. It adds no wardrobe storage capacity and is not an alternative backup store. No Azure service is created by this blueprint.

If an optional Azure experiment is later approved, use a dedicated resource group/subscription where practical, alert at 50%/80%/100% of a small named budget, and enforce a server-side request/token/image limit plus a disabled-by-default switch. Budget alerts are notifications, **not hard spending caps**. Credit spending limits differ by subscription type and must be verified in that account. Do not remove an existing credit spending limit. If no hard credit cap applies, prefer leaving the experiment disabled over promising a guaranteed $0 bill.

If a free tier changes, first switch the static host without moving private data. For database exit, export owner data and image bytes, deploy the same Postgres schema with a replacement identity adapter, rebind the two new user UUIDs and run the access suite before cutover. Keep provider-specific Auth/Storage calls behind adapters (`13`). Database backups do not contain object bytes. A managed upgrade or self-hosted Postgres is a later user decision; self-hosting has patching/backup costs even when software is free.

The weekly backup schedule, pause recovery and tested restore procedure are defined once in `17-DEPLOYMENT-AND-RECOVERY.md`.

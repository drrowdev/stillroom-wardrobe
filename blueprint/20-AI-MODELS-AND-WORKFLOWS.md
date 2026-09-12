# AI models and automatic clothing details

Revision **1.4**, 6 September 2026. The workflow remains **photo upload -> automatically filled editable form -> explicit Save to library**. Outfits remain deterministic. Supabase's project region is now Stockholm (`eu-north-1`); AI processing region is separately configured. Low cost is a goal, not a hard $0 limit. This document activates no provider, payment or image transfer.

## Task allocation

| Task | First-release approach | Model needed? |
|---|---|---|
| Clothing details before library Save | Automatically analyze the prepared photo and fill the draft form, including title/category. Every garment field is editable before the owner saves it. | One image-understanding model, selected below |
| Outfit generation and ranking | Existing owner-only deterministic templates, hard constraints, scoring and feedback in `09`, using saved clothing details | No additional model or API call |
| Outfit explanations | Verified rule reasons rendered through the English/Finnish/Swedish catalog | No language model |
| Weather | Opt-in weather API plus explicit context; no AI weather prediction | No model |
| Crop, orientation, resizing and metadata removal | Browser pixel processing before upload | No model |
| Background removal, multi-garment extraction, image generation, virtual try-on and chat | Deferred; none is required to deliver automatic tagging | No model installed or selected for MVP |
| A later conversational stylist or AI outfit reranker | Separate user decision and measured benefit over the rule baseline; the selected text-capable model could be evaluated again then | No first-release endpoint, calls or acceptance requirement |

An image model supplies useful descriptions; it does not establish physical warmth or guarantee attractive outfits. More expensive models cannot recover information that is not visible. Do not add an embedding model, vector database, model-training pipeline or separate stylist model for a 500-item wardrobe.

## Researched model candidates

The expanded **2026-09-06** comparison is in `21-AI-MODEL-COMPARISON.md`, covering Google, OpenAI, Anthropic and Mistral. The old Flash-Lite-versus-Terra comparison was too narrow. Eligibility, regional access and correction effort precede small price differences. No candidate has a demonstrated garment-accuracy lead here. Pin model/product/region/schema/image settings during I29; no automatic provider switch.

| Candidate | Planned use and route | Standard input / output per million tokens | Regional considerations |
|---|---|---|---|
| **Provisional start: `gemini-3.5-flash-lite`** | Paid Google Cloud, image + structured output; minimal thinking. Deployment fit, not lowest cost or proven best accuracy. | $0.30 / $2.50 globally | EU multi-region $0.33 / $2.75; explicit route, not global |
| **Main comparator: `gpt-5.4-mini-2026-03-17`** | OpenAI, image + strict Structured Outputs; reasoning none | $0.75 / $4.50 | European image processing needs enhanced retention-control approval; 10% premium |
| **Economy challenger: `gpt-5.6-luna`** | OpenAI, image + strict Structured Outputs; explicitly set reasoning none | $0.20 / $1.20 | Same image/region eligibility gate; cheaper token rates alone do not establish accuracy |

Sources: [Google Cloud model](https://docs.cloud.google.com/gemini-enterprise-agent-platform/models/gemini/3-5-flash-lite), [Google prices](https://cloud.google.com/gemini-enterprise-agent-platform/generative-ai/pricing), [5.4 Mini](https://developers.openai.com/api/docs/models/gpt-5.4-mini), [Luna](https://developers.openai.com/api/docs/models/gpt-5.6-luna), [OpenAI prices](https://developers.openai.com/api/docs/pricing). `21` adds conditional Mistral Small 4, Claude Haiku 4.5/Sonnet 5, Gemini 3.8 Flash, Mistral Medium 3.5 and `gpt-5.6-terra` baselines, with terms/retention/lifecycle differences.

Cloud Flash-Lite lists availability from 2026-07-21 and retirement on 2027-07-21 or later. Recheck model-specific lifecycle, terms, regional image access and prices before activation/replacement. Compare two eligible candidates using `21`; no failed request is sent to a second company automatically. Older cheap models with imminent retirement are not default choices.

**Provider product matters.** Google Cloud and Gemini Developer API/AI Studio are not interchangeable contracts. The reviewed [Developer API terms](https://ai.google.dev/gemini-api/terms) restrict the service to professional/business purposes, creating an eligibility issue for this private consumer app. Use the separately reviewed [Google Cloud terms](https://cloud.google.com/terms) for the proposed Cloud route. Operator confirmation of eligibility is required before activation; this document is not a legal eligibility determination. Do not use a free AI endpoint to avoid either billing approval or privacy requirements.

## Photo-first draft, review and Save

1. Each owner independently enables automatic photo analysis after a one-time provider notice. It explains that the photo is sent for analysis **before Save to library**: discarding the draft does not undo that transfer or its possible charge. There is no separate "Suggest tags" button.
2. Select or take a photo, crop/rotate if needed, then prepare bounded metadata-free main/thumbnail JPEGs locally. No name or category is required to start. When photo preparation finishes, automatically send the sanitized main image to the authenticated analysis endpoint; do not analyze every crop-handle movement.
3. The endpoint returns validated attributes without creating or changing a library item. Populate the normal form: title, category, visible clothing details, editable image description and suitable tags. Generate the initial title/description locally from detected attributes and the current language catalog; no second model call.
4. Show photo and filled form together. Every user-facing garment field can be edited, cleared or corrected, including title/category and the description. Optional details use the existing expandable sections. Label estimates and not-detected values; no separate confirmation per field.
5. Only **Save to library** creates the item and uploads/commits its persistent private images. Validate required photo/title/category here, whether AI-filled or manually entered. Freeze exactly the displayed draft values for that save. Save does not convert estimates into confirmed physical facts.
6. Cancel/discard clears the draft and creates no library item or image. Saved items remain editable afterward. AI never enriches a saved item in the background; photo replacement also uses an editable draft and explicit Save before replacing current data/images.

AI runs automatically; **library saving does not**. Unsaved photos/fields live in session memory, apart from the temporary analysis receipt below, and never enter the wardrobe, search, suggestions, calendar, statistics or exports. Closing/reloading can lose the unsaved draft; navigation warnings are best-effort on phones, not a persistence guarantee.

The form remains editable during analysis. Track untouched, manually edited/cleared, and not-detected fields separately. Results fill only untouched fields for the current draft/photo generation. Replacing/cropping the photo cancels the old generation; old AI-derived values are cleared or visibly marked stale, while manual edits remain. Logout, account switch, discard and completed Save invalidate late responses.

Use a bounded analysis timeout (initial target: 20 seconds). Timeout, refusal, missing consent, budget exhaustion or unclear imagery reveals the same form with explicit unknown fields and retry/manual-entry guidance. "Continue manually" cancels analysis and allows Save once required values are supplied. Never trap Save behind a failed provider, invent values to complete the form, or report a draft as saved.

## Attribute contract and uncertainty

Use a versioned, bounded response schema and canonical taxonomy codes, not arbitrary hashtags or instructions. Google requests use `responseMimeType: application/json` and supported `responseSchema`; OpenAI uses strict JSON-schema Structured Outputs. Parse and validate domain values server-side. Valid JSON is not evidence that an observation is true.

| Attribute | Automatic treatment |
|---|---|
| Title, image description and tags | Prefill editable text using detected attributes and the current language. Do not invent brand/material in the title. Saved text is not automatically translated later. |
| Category/subcategory, main colours, visible pattern, sleeve and garment length | Prefill valid observations only in untouched fields. Unclear, cropped or folded views can yield not detected. |
| Coverage | Prefill observed coverage when visible. Do not convert an ambiguous hem/sleeve into confirmed coverage. |
| Material, formality, season and style | Prefill supported, bounded estimates with visible estimate labels, not physical guarantees. |
| Warmth, temperature limits, rain rating and windproofing | Leave unknown unless supplied by the owner or explicitly entered from a trusted garment specification. Do not infer waterproofness or insulation from a picture. |
| Brand and size | Prefill only if clearly readable on the garment/label, as unverified observations; otherwise blank. Never guess or follow photographed instructions. |
| Price, purchase date and personal notes | Leave blank unless the owner enters them. No fabricated purchase history. |
| Availability, lifecycle, currency and favourite | Visible editable app defaults: `ready`, `active`, owner's currency, not favourite. These are not AI observations. |
| Ownership, identifiers and wear history | System-controlled, not editable garment details and never set by the model. |

I29 defines finite `pattern`, `sleeve_length` and `garment_length` codes alongside the existing taxonomy, with three-language labels. A multi-garment/unclear photo retains an unsaved draft and asks for a clearer crop or manual details, not several invented items. "Fill everything" means fill supported details and expose every field for editing, not invent unknown facts.

Extend `items` with bounded per-field provenance/revisions: `unknown`, `ai_observed`, `ai_estimated`, or `user`. Persist only on Save. Record model/prompt version and prepared-image hash; bind the source image ID after image commit. A manual clear is `user` with null/empty content. The save operation validates provenance against the owned receipt/current photo; arbitrary requests cannot label estimates as user-confirmed.

I29 also adds a narrow owner/version-checked description edit, with an `item_images.description_version` counter. It updates `alt_text` and that counter only, without re-uploading or changing immutable paths, hashes or bytes. New reservations accept the edited description at Save. This closes the editing gap without loosening media protections.

Source-image provenance must not prevent normal retired-image cleanup. Keep its hash/model/version as descriptive history; make the source-image link nullable when the file record is permanently removed. Restore remaps a source image only if it is present in the backup, otherwise retaining a null link rather than inventing an image.

Remove fake factual defaults for unentered formality, warmth, coverage, rain rating and windproofing in the I29 migration. For old rows with no provenance, mark these fields unverified; do not claim to know which historical defaults were manually confirmed, or destroy existing text. A migration must preserve data while requiring confirmation where a hard rule needs an unknown property.

`09` handles unknown values explicitly: omit unknown soft-score components and renormalize; when an unknown property is essential to a hard constraint, show a partial result and the missing detail. Unknown is neither a silent pass nor a fabricated negative fact. AI-estimated material/style cannot satisfy a hard weather-protection rule. Do not display confidence percentages as calibrated probabilities.

## Analysis endpoint, receipts and retries

Keep Supabase as the single backend. Add authenticated `analyze-clothing`; deletion remains separate. The endpoint returns draft attributes and **never creates or updates library items**. Revision 1.2's `ai_jobs`, scheduled tagging worker and image-commit enqueue are superseded. No inference scheduler, queue or outfit-AI endpoint is needed.

The planned additive migration introduces:

* Owner-only AI preferences on `profiles`: enabled flag, provider-notice revision and consent time. These do not grant access to another account or expose provider credentials.
* Item fields/provenance, checked draft-save/manual-edit paths and the narrow description edit. Saved-row title/category constraints remain; no row is required before analysis.
* `private.ai_requests`: owner, request UUID, draft generation, server-computed image hash, pinned model/prompt, bounded status/result and expiry. No photo bytes, raw prompts/responses or credentials. An owner API returns only that person's validated result/status.
* `private.ai_usage`: minimal owner-bound cost/reservations, separate from short-lived results. No photos, garment text, credentials or other-account totals in client responses.

Verify the caller's token, current admission, consent and allowance before analysis. Accept bounded sanitized JPEG bytes and a request UUID, never a caller-selected owner, saved-item target or external URL. Revalidate signature/dimensions/metadata server-side. Send the main image inline; create no Supabase image object until explicit library Save.

Atomically claim `(owner, request UUID)` and reserve cost. Bind it to image hash/draft generation/model: identical retries return existing status/result without another inference; conflicting reuse is an error. Allow one active analysis per draft. Status checks, field edits, language changes and Save must not trigger paid reanalysis.

Keep a bounded validated result for at most 24 hours, with owner-authenticated discard cleanup and an expiry purge. Discard removes the result; a minimal cost receipt can remain for reconciliation. Receipts are not cloud draft recovery. After expiry, preserve open form values as unverified unless manually supplied; explain expired provenance rather than silently rerunning a paid request or marking estimates confirmed.

Recheck consent/membership before returning results. Cancellation/browser closure may not stop the provider or its charge. Crashes/timeouts after dispatch can leave billing unknown; no blind retry. Status lookup is safe; a deliberate new attempt needs a new bounded reservation. Reconcile expired reservations conservatively. Failure returns a recoverable state, not success-shaped data.

Discard, photo changes, edits, account changes and Save invalidate the corresponding draft generation. No late response edits a saved garment. Freeze/deletion denies new calls/results and removes analysis data. Export saved attributes/provenance only, not requests, drafts or usage.

### B2 explicit Save reservation boundary

The owner-selected rule is **Finish the already-started Save**. After a valid
first Save reservation has frozen the accepted intent and genuine owned B1
attestation, later AI opt-out, analysis-only discard, expiry or operator AI
deactivation does not cancel that Save or erase truthful frozen attribution.
No inference occurs during Save/retry. Account freeze/deletion and current
owned row/object guards still block it; explicit cancellation of the Save itself
is respected. Expired or discarded proof before FIRST reservation fails; retaining
values requires a separate explicit unknown/manual snapshot, not automatic
downgrade, confirmation or reanalysis.

B2 source supplies a separate analyzed/unknown composer and checked reservation,
authenticated synchronous main/thumb byte finalizer, service-only narrow
completion and minimal owner-readable completed attribution history. It preserves
manual overrides/clears and explicit unknown@1, without changing the manual
composer/transport. Both raw INSERT and UPDATE/import remain unable to mint AI
trust. Receipt-use identities survive result/item deletion; the completed
source-image link alone becomes null during normal image cleanup. See `08` for
the exact owner, fingerprint and Storage ID/opaque-version boundary.

This source packet supports the existing fourteen B1 facts; automatic title,
description and photo-first UI integration are not included or complete.
New exact-head CI execution, genuine independent review and coordinator-owned
artifact review remain owed. Raw-v2/saved-only backup and restoration of trusted
history remain parked and mandatory before release, not silently implemented
or waived here. Source editing does not authorize paid/provider/hosted activation.

## Privacy and cost controls

Send the sanitized photo, fixed instructions and taxonomy only, before library Save. No history, account email, location, notes, other photos or peer data. EXIF removal does not hide identifying pixels. Use inline bytes, not a public bucket, persistent vendor file or reusable signed link. Temporary validated results are owner-only and excluded from wardrobe queries/exports.

Google Cloud states it does not train on customer data without permission, but flagged abuse prompts can be retained for up to 90 days. Its default in-memory caching has a 24-hour TTL and can be disabled. OpenAI API data is not used for training by default; ordinary abuse-monitoring retention can be up to 30 days, with stated exceptions. Use `store:false` for OpenAI Responses and disable optional logging/data-sharing features. These controls are not a zero-retention guarantee. EU Supabase hosting alone says nothing about the AI processing region.

Sources: [Cloud data controls](https://docs.cloud.google.com/gemini-enterprise-agent-platform/resources/zero-data-retention), [Cloud abuse monitoring](https://docs.cloud.google.com/gemini-enterprise-agent-platform/models/abuse-monitoring), [Cloud region commitments](https://docs.cloud.google.com/gemini-enterprise-agent-platform/resources/data-residency), [OpenAI data controls](https://developers.openai.com/api/docs/guides/your-data).

Before any paid call, the operator approves the provider product, model, region and a finite monthly allowance per account. No implicit unlimited budget. Atomically reserve a conservative maximum request cost before dispatch; reconcile actual billed input/output, including thinking tokens. Include retries, existing reservations and uncertain timed-out charges. Warn at 80% and stop new paid calls at the application allowance; already-sent requests can still complete. Provider alerts are not hard spending caps.

`21` compares rates with a normalized illustration of 2,000 total input/500 billed output tokens per analysis; it is not a measured price per photo. At 1,000 analyses, global examples are $1.85 Flash-Lite, $3.75 GPT-5.4 Mini and $1.00 Luna, before region premiums/retries/taxes. **Discarded drafts, replacements and completed crops can also cost money.** Count analyses, not saved garments; limits remain in `11`.

## Migration, backup and rollout gates

`07` remains the **revision 1.1 base schema**. It does not implement AI fields, receipts or description-edit controls. I29 adds its migration/types/tests before the analysis endpoint. Analysis creates no item rows, so saved-row title/category constraints remain valid. Save can create an incomplete upload reservation only after explicit user action; exclude it from the library until image commit succeeds.

Because the export contains new fields and uncertainty semantics, I29 specifies metadata `schema_version: 2` and corresponding part `schemaVersion: 2`. Keep the existing encryption envelope version 1. Phase 6 must read both metadata versions, verify original hashes before conversion, and preserve old v1 values as unverified where provenance is absent. Retain the documented v1 mapping namespace for v1 resumes; version-2 imports use a separately fixed v2 namespace.

Export only saved attributes/provenance. Remap source images, preserve manual overrides and exclude drafts, results and usage. Consent/allowance belong to the target account, never a backup. Import and image commit do not call analysis; there is no post-commit enqueue.

I29 covers photo-only start, automatic title/category/details, editing every garment field before Save, zero library writes on analysis/discard, exact reviewed-value Save and later editability. Include manual clears, stale photos, timeout/manual fallback, expiry, logout, budget races, duplicate requests, unknown physical properties, description editing and restore without AI calls. No test requires background tagging after browser closure or library Save.

Before adoption, use `21`'s comparison procedure with at least 30 authorized representative photos and two eligible candidates. Require at least 90% correct category/main-colour labels on clear single garments, no invented physical protection, and explicit per-field error/unknown/correction-time reporting. Prefer fewer corrections over small token-price savings. Record complete-response latency and actual billed usage. These are future acceptance targets, not measured results.

The final release includes working automatic tagging for enabled accounts, plus the existing real dressing-usefulness evaluation for deterministic suggestions. No AI service has been configured or evaluated by this blueprint revision.

## I29 B1 source implementation boundary — 11 September 2026

The approved B1 packet supplies a real, inactive-by-default server adapter and
atomic claim/settlement protocol, not automatic UI analysis or full I29 delivery.
The exact source contract is in `08`; the source-only route/tariff decision and
remaining financial gates are in `21`. The 14 fact fields remain the existing
ten observed/four estimated partition. Title/description presentation, draft
application and trusted Save binding are not silently added to this backend.

Only `index.ts` reads server configuration: Supabase runtime keys and
`AI_GOOGLE_PROJECT_ID`, `AI_GOOGLE_CLIENT_EMAIL`, `AI_GOOGLE_PRIVATE_KEY`.
The adapter performs a fixed RS256 OAuth exchange, then one fixed Google Cloud
EU request with inline sanitized bytes, fixed prompt/schema, LOW thinking,
`includeThoughts:false`, 4096 output tokens, HIGH media resolution and standard
safety thresholds. It has no SDK credential discovery, tools, file upload,
external image URL, processor fallback or automatic inference retry.

Local validation runs the actual CLI entrypoint unconfigured and the production
handler against real ordinary Auth/DB with **only Google transport synthetic**.
These are engineering tests, not paid accuracy, billing, retention, regional
wire, hosted rollout or representative-photo evidence. No provider credential,
private photo or paid call is used. Save/restore never invokes this adapter.

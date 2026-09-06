# Current garment-image model comparison

Revision **1.4**. Official sources accessed **6 September 2026**. This is a dated documentation comparison, not a live garment benchmark or continuous price monitor. No inference, personal-photo transfer, paid activation or account-specific access verification was performed.

## Recommendation and why Gemini was proposed

The application needs one model to describe a prepared garment photo as bounded structured fields, not an image generator or an AI stylist. The owner edits the filled form before Save. Outfits remain deterministic.

Gemini 3.5 Flash-Lite was proposed because it supports image input and structured output, has an economical classification/extraction mode, and has a documented Google Cloud EU pay-as-you-go route. **It was not selected through a clothing benchmark and is not the cheapest current model.** The earlier two-model comparison was too narrow; GPT-5.6 Terra should not be the only alternative.

Keep **Google Cloud EU + `gemini-3.5-flash-lite` as a provisional starting configuration**, subject to terms and model evaluation. Compare **GPT-5.4 Mini** as the main alternative and **GPT-5.6 Luna** as an economy challenger if their processing/access arrangements are acceptable. Mistral Small 4 is financially competitive but has unresolved private-use, training-setting and regional-access gates. Claude Sonnet 5 and Gemini 3.8 Flash are additional comparison baselines, not presumed quality winners.

Decision order: permitted use and acceptable processing/retention -> supported image-plus-schema response -> fewer incorrect or invented fields and less user editing -> complete-response latency -> actual cost. At approximately 1,000 initial garments, small token-price differences should not outweigh repeated corrections or awkward provider setup.

## Currently documented models

All rows support image input and schema-based structured output in the reviewed model/API documentation. This does not prove photographic accuracy, complete refusals handling or account-specific access. Rates are **USD per million ordinary uncached input/output tokens**, excluding tax, regional premiums, reasoning beyond the stated output count and application infrastructure.

| Model | API identifier to evaluate | Input / output | Role and caveat |
|---|---|---:|---|
| Gemini 3.5 Flash-Lite | `gemini-3.5-flash-lite` | $0.30 / $2.50 | Provisional Cloud EU start; minimal thinking suits bounded extraction. |
| GPT-5.4 Mini | `gpt-5.4-mini-2026-03-17` | $0.75 / $4.50 | Main OpenAI comparator. Older does not mean worse for garment details; lower price than Terra. |
| GPT-5.6 Luna | `gpt-5.6-luna` | $0.20 / $1.20 | Economy challenger; cheaper token rates than Flash-Lite. Default reasoning must be reduced explicitly. |
| Mistral Small 4 | `mistral-small-2603` | $0.15 / $0.60 | Lowest rates in this current shortlist; private-use eligibility and regional/training settings need resolution. |
| Claude Haiku 4.5 | `claude-haiku-4-5-20251001` | $1.00 / $5.00 | Valid efficient Claude comparator, not a price leader; check lifecycle and deployment terms. |
| Claude Sonnet 5 | `claude-sonnet-5` | $2.00 / $10.00 | Additional baseline for correction effort/label reading; better wardrobe accuracy is unproved. |
| Gemini 3.8 Flash | `gemini-3.8-flash` | $0.75 / $3.75 introductory | Newly released baseline. From 2027-01-01: $1.50 / $7.50 under the current published schedule. |
| GPT-5.6 Terra | `gpt-5.6-terra` | $2.00 / $12.00 | Higher-cost current mini-tier baseline, not automatic fallback or an assumed upgrade over 5.4 Mini. |
| Mistral Medium 3.5 | `mistral-medium-3-5` | $1.50 / $7.50 | Conditional additional Mistral baseline if Small 4's results justify further evaluation. |

**Google sources:** [model catalog](https://ai.google.dev/gemini-api/docs/models), [3.5 Flash-Lite](https://docs.cloud.google.com/gemini-enterprise-agent-platform/models/gemini/3-5-flash-lite), [3.8 Flash](https://docs.cloud.google.com/gemini-enterprise-agent-platform/models/gemini/3-8-flash), [Cloud pricing](https://cloud.google.com/gemini-enterprise-agent-platform/generative-ai/pricing).

**OpenAI sources:** [5.4 Mini](https://developers.openai.com/api/docs/models/gpt-5.4-mini), [Luna](https://developers.openai.com/api/docs/models/gpt-5.6-luna), [Terra](https://developers.openai.com/api/docs/models/gpt-5.6-terra), [pricing](https://developers.openai.com/api/docs/pricing).

**Anthropic sources:** [models and pinned IDs](https://platform.claude.com/docs/en/models/overview), [pricing](https://platform.claude.com/docs/en/about-claude/pricing). The previously scheduled September Sonnet 5 price increase was canceled according to the live pricing page; $2/$10 is now its standard rate.

**Mistral sources:** [Small 4](https://docs.mistral.ai/models/mistral-small-4-0-26-03), [Medium 3.5](https://docs.mistral.ai/models/mistral-medium-3-5-26-04), [pricing](https://docs.mistral.ai/inference/pricing). Mistral Large 3 (`mistral-large-2512`, $0.50/$1.50) is another possible intermediate comparison; names such as "Large" do not imply higher cost than every newer "Medium".

Do not add every model to the application. One reviewed provider/model configuration ships. The table is a selection aid, not nine integrations or permission for automatic cross-provider retries.

## Cost perspective

To compare rates without pretending different image tokenizers are identical, use a **normalized illustration**: 1,000 independent analyses, each with 2,000 total input tokens including image/prompt and 500 total billed output tokens including any reasoning. No cache/batch discount or retries.

| Model | Illustrative total for 1,000 analyses |
|---|---:|
| Mistral Small 4 | $0.60 |
| GPT-5.6 Luna | $1.00 |
| Gemini 3.5 Flash-Lite | $1.85 |
| Gemini 3.8 Flash, introductory / later | $3.38 / $6.75 |
| GPT-5.4 Mini | $3.75 |
| Claude Haiku 4.5 | $4.50 |
| Mistral Medium 3.5 | $6.75 |
| Claude Sonnet 5 | $9.00 |
| GPT-5.6 Terra | $10.00 |

These are **not measured prices per garment photo**. Image detail, tokenization, output length, thinking, retry and discarded drafts all change actual usage. Initial cataloging is followed by ongoing charges for new/replaced photos; it is not a one-time unlimited subscription. Region/product premiums below are excluded.

Cloud Gemini non-global processing adds 10% at the cited rates: Flash-Lite EU is $0.33/$2.75. Gemini 3.8's introductory effective Cloud rate may be delivered partly through credits; account invoices and post-promotion rates need confirmation. Eligible OpenAI residency endpoints, Mistral regional endpoints and the documented Claude Cloud regional route also add 10%. No account's eligibility or final invoice is established here.

## Image detail and reasoning settings

| Provider | Relevant control |
|---|---|
| Google | Start Flash-Lite at `minimal`; 3.8 Flash supports `low`, not `minimal`, and defaults to `medium`. Gemini 3 high-detail image allocation is approximately 1,120 tokens; medium 560, low 280, ultra-high 2,240. Thinking is billed as output. |
| OpenAI | Start Luna/Terra with reasoning `none`, not default `medium`; 5.4 Mini defaults to `none`. Set image detail explicitly to `high`: GPT-5.6 `auto` follows `original`, not necessarily an inexpensive representation. The documented 32-pixel patches use a 1.2 multiplier for these candidates. |
| Anthropic | Start with thinking disabled, especially Sonnet 5 where it is on by default. Vision documentation uses 28-pixel patches; newer Sonnet has a larger image budget than Haiku, not an automatic need to send larger photos. |
| Mistral | Start with `reasoning_effort: none`. Current docs establish token-based image input charging but do not clearly specify the exact Small 4/Medium 3.5 image tokenization formula. Measure actual usage rather than borrowing a deprecated model's formula. |

Sources: [Google media resolution](https://ai.google.dev/gemini-api/docs/media-resolution), [thinking](https://ai.google.dev/gemini-api/docs/thinking), [OpenAI vision](https://developers.openai.com/api/docs/guides/images-vision), [reasoning](https://developers.openai.com/api/docs/guides/reasoning), [Claude vision](https://platform.claude.com/docs/en/build-with-claude/vision), [Sonnet behavior](https://platform.claude.com/docs/en/models/sonnet-5/whats-new-sonnet-5), [Mistral vision](https://docs.mistral.ai/studio/conversations/vision), [reasoning](https://docs.mistral.ai/studio/conversations/reasoning).

Use a bounded output limit covering billed thinking and final JSON, not just visible fields. GPT-5.6 cache writes can cost 1.25 times input; do not assume savings for unrelated garment photos. [OpenAI caching](https://developers.openai.com/api/docs/guides/prompt-caching). Keep image preprocessing, visible garment content and output schema equivalent during comparison without forcing an identical token count.

## Eligibility, privacy and region come before price

The selected Supabase project region is **Stockholm (`eu-north-1`)**. This does not select the AI provider's processing region. "No training", short application-state retention and geographically restricted inference are distinct properties.

| Provider product | What is documented | Setup gate for this private app |
|---|---|---|
| Google Cloud model API | Flash-Lite and 3.8 have EU multi-region pay-as-you-go processing, using `aiplatform.eu.rep.googleapis.com`. Cloud terms refer to an entity or person. No training without permission; flagged abuse prompts can be retained up to 90 days in the selected region. Default 24-hour in-memory cache can be disabled. | Review Cloud terms/account eligibility, select the explicit EU route and disable optional logging/cache. This is EU processing, not Stockholm-only inference. |
| Gemini Developer API / AI Studio | Terms specify professional/business rather than consumer use. Paid data-use terms differ from free usage; published transient storage is not EU-only and abuse retention is 55 days. | Do not substitute this route for Cloud in a purely personal app or assume paying removes the use restriction. |
| OpenAI direct API | No training by default; ordinary abuse retention up to 30 days. Responses `store:false` avoids its default application-state storage, not all abuse logs. European processing covers EEA + Switzerland. | Non-US residency requires approved controls/amendment; **image support requires enhanced retention-control approval**. Verify this account's access before promising a European photo-processing route. |
| Anthropic direct API | No model training on API customer content under commercial terms; ordinary input/output retention up to 30 days with exceptions. Direct inference geography is global/US, not EU. Commercial terms say not for consumer use. | Clarify private-use eligibility. Do not claim direct API EU processing. Claude via separately configured Google Cloud has an EU pay-as-you-go route, but model availability/terms must be confirmed there. |
| Mistral direct API | `api.eu.mistral.ai` is a regional option, but its table includes EU **and EFTA** countries. Ordinary API retention is 30 days; ZDR needs approval. Paid-plan training opt-out must be verified explicitly. EU consumer terms reserve API access to business customers. | Resolve eligibility, disable API improvement/training use, accept/clarify geography, and verify the chosen model is available on that regional endpoint. EU headquarters do not prove EU-only processing. |

**Google:** [Cloud terms](https://cloud.google.com/terms), [Developer API terms](https://ai.google.dev/gemini-api/terms), [Cloud locations](https://docs.cloud.google.com/gemini-enterprise-agent-platform/resources/locations), [residency](https://docs.cloud.google.com/gemini-enterprise-agent-platform/resources/data-residency), [retention](https://docs.cloud.google.com/gemini-enterprise-agent-platform/resources/zero-data-retention), [abuse monitoring](https://docs.cloud.google.com/gemini-enterprise-agent-platform/models/abuse-monitoring).

**OpenAI:** [data controls, retention and image residency eligibility](https://developers.openai.com/api/docs/guides/your-data).

**Anthropic:** [direct residency](https://platform.claude.com/docs/en/manage-claude/data-residency), [Claude on Google Cloud](https://platform.claude.com/docs/en/build-with-claude/claude-on-vertex-ai), [commercial terms](https://www.anthropic.com/legal/commercial-terms), [retention policy](https://privacy.claude.com/en/articles/7996866-how-long-do-you-store-my-organization-s-data).

**Mistral:** [regional inference](https://docs.mistral.ai/inference/regional-inference), [EU consumer terms](https://legal.mistral.ai/terms/eu-consumers-terms-of-service/), [training choices](https://help.mistral.ai/en/articles/347617-do-you-use-my-user-data-to-train-your-artificial-intelligence-models), [API opt-out](https://help.mistral.ai/en/articles/455207-can-i-opt-out-of-my-input-or-output-data-being-used-for-training), [privacy](https://legal.mistral.ai/terms/privacy-policy/), [ZDR approval](https://docs.mistral.ai/admin/monitor-comply/zero-data-retention).

These are procurement/consent gates, not legal advice or a statement that an individual account has been approved. An alternate cloud route changes the contract, authentication, pricing and processing commitments; document the actual route rather than inheriting a direct API's claims.

## Exclusions and lifecycle cautions

* **Gemini 2.5 Flash-Lite:** cheap ($0.10/$0.40), but its Cloud retirement is listed for **20 October 2026**. The Developer API schedule differs; do not confuse products. Not a sensible new Cloud production default. [Cloud lifecycle](https://docs.cloud.google.com/gemini-enterprise-agent-platform/models/gemini/2-5-flash-lite).
* **Old Pixtral, Mistral Small 3.2 and Medium 3.1:** individual current model pages mark them deprecated even where general vision examples still mention them. Prefer active model pages. [Pixtral](https://docs.mistral.ai/models/pixtral-12b-24-09), [Small 3.2](https://docs.mistral.ai/models/mistral-small-3-2-25-06), [Medium 3.1](https://docs.mistral.ai/models/mistral-medium-3-1-25-08).
* **GPT-5 mini/nano originals:** retirement notices must not be confused with active 5.4 Mini or 5.6 models. [OpenAI deprecations](https://developers.openai.com/api/docs/deprecations).
* **Haiku 4.5:** a minimum retirement commitment is not a promised scheduled retirement; recheck current lifecycle rather than interpreting the date as an automatic shutdown.
* **Gemini 3.8 Flash:** newly released and introductory-priced. Recheck ordinary rates after 31 December 2026 and do not infer superior garment results from its release date.

Large context windows, coding scores and image-generation quality are not decisive for a single-garment extraction task. General vision/OCR benchmarks can justify including a candidate, not establish its clothing-label accuracy.

## I29 selection procedure

1. Confirm eligible provider products, actual account/regional image access and owner consent for each proposed processor **before sending any photos**. Start with two eligible candidates rather than integrating all nine. If a route fails its gate, document that instead of quietly using global/free processing.
2. Use at least 30 authorized representative photos, covering clear single garments, patterns, folded/cropped views, labels that are readable/unreadable, and uncertain materials. Establish owner-provided reference fields. Use the same prepared pixels and canonical schema for each model with its appropriate image settings.
3. Record field-level correctness, invented brand/material/size claims, useful unknowns, number/time of user corrections, total form-ready latency, incomplete/refused responses and actual billed usage. No fabricated insulation/waterproofness/price; schema validation must not force a guess.
4. Keep `20`'s baseline gate of at least 90% correct category/main-colour labels on the clear subset, but do not choose by that alone. Prefer materially fewer corrections and reliable abstention; if comparable, prefer the simpler acceptable deployment, latency and then cost.
5. Generate localized titles/descriptions in the app as already planned; switching models does not introduce an AI translation service. Verify all three UI languages without comparing translated category codes.
6. Record the chosen API ID/snapshot, product/region, schema/prompt/image settings, observed results and allowance in `docs/ai-model-selection.md`. Model replacement needs review and processor disclosure; never auto-failover a private photo to another provider.

**Current conclusion:** Gemini 3.5 Flash-Lite has a credible deployment fit, not a demonstrated accuracy lead. The winner for this wardrobe must be selected by the permitted route and actual correction burden, not by the incumbent recommendation or marketing scores.

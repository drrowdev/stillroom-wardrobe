# Focused public product study

Original study access date: **2026-09-05 (UTC)**. The original ledger contains twelve distinct source pages including technical/provider evidence. A separate 2026-09-06 AI supplement appears below. No app installation, login, private endpoints, traffic inspection or paid access. Redirects of a listed page are the same source. No screenshots or branded assets are copied into this package.

`CONFIRMED` means a public source states the claim, not independent verification that the feature works. `OBSERVED` means something visible in the public interface. `INFERRED` marks interpretation. `PROPOSED` marks our design. Store reviews are dated anecdotes, not evidence of current defect frequency.

## Source ledger

| ID | Public source | Used for |
|---|---|---|
| S01 | [Acloset website](https://www.acloset.app/) | Product's own feature descriptions and public navigation |
| S02 | [Official Apple listing](https://apps.apple.com/us/app/acloset-ai-fashion-assistant/id1542311809) | Item details, wear metrics, reviews, privacy disclosures |
| S03 | [Supabase pricing](https://supabase.com/pricing) | Free allowances, inactivity, backups and upgrade baseline |
| S04 | [Supabase Storage access control](https://supabase.com/docs/guides/storage/security/access-control) | Storage RLS and privileged-key boundary |
| S05 | [Azure Static Web Apps quotas](https://learn.microsoft.com/en-us/azure/static-web-apps/quotas) | Free host quotas; page itself last updated 2024-05-30 |
| S06 | [Open-Meteo pricing](https://open-meteo.com/en/pricing) | Noncommercial free API and request limits |
| S07 | [Apple Developer Program](https://developer.apple.com/programs/) | Native distribution membership cost |
| S08 | [React repository](https://github.com/react/react) | UI library purpose and MIT licence |
| S09 | [Supabase JavaScript SDK repository](https://github.com/supabase/supabase-js) | SDK components, runtime support and MIT licence |
| S10 | [Vite repository](https://github.com/vitejs/vite) | Static application build tooling and MIT licence |
| S11 | [IMG.LY background removal repository](https://github.com/imgly/background-removal-js) | Local segmentation option and AGPL licence |
| S12 | [Cloudflare Pages](https://www.cloudflare.com/products/pages/) | Free static hosting, bandwidth and SSL |

The technical findings are recorded at their point of use in `05` and `11`; those tables cite these same pages. This ledger does not imply that release timestamps, every linked policy, or every platform capability was independently audited.

## Product findings

| Label | Finding | Evidence / accessed |
|---|---|---|
| CONFIRMED | Photo capture, store import and automatic item organisation are advertised. | [S01](https://www.acloset.app/) · 2026-09-05 |
| CONFIRMED | Outfit suggestions use the user's clothing, weather and schedule. | [S01](https://www.acloset.app/) · 2026-09-05 |
| CONFIRMED | Daily wear tracking, trip packing and wardrobe statistics are advertised. | [S01](https://www.acloset.app/) · 2026-09-05 |
| CONFIRMED | Photo enhancement, item detection, virtual try-on and a shopping browser extension are described. | [S01](https://www.acloset.app/) · 2026-09-05 |
| OBSERVED | The public website links Features, Magazine, About, FAQ and Announcements. These are website links, not verified in-app tabs. | [S01](https://www.acloset.app/) · 2026-09-05 |
| CONFIRMED | The listing describes purchase dates/prices, planned outfits, cost per wear and a community. | [S02](https://apps.apple.com/us/app/acloset-ai-fashion-assistant/id1542311809) · 2026-09-05 |
| CONFIRMED | Developer privacy disclosures list tracking categories and coarse location linked to identity; Apple says these declarations are unverified. Actual privacy switches were not inspected. | [S02](https://apps.apple.com/us/app/acloset-ai-fashion-assistant/id1542311809) · 2026-09-05 |
| CONFIRMED | A January 2023 review describes unwanted outerwear/accessories, unsuitable suggestions and saving difficulties. | [S02](https://apps.apple.com/us/app/acloset-ai-fashion-assistant/id1542311809) · 2026-09-05 |
| CONFIRMED | A June 2022 review requests lasting rejection feedback; a November 2021 review reports recommendation errors, later resolved by an update. | [S02](https://apps.apple.com/us/app/acloset-ai-fashion-assistant/id1542311809) · 2026-09-05 |

The website's user-count marketing and older store description differ; neither is needed for this design. They are not reconciled into an invented current count. Historical reviews identify failure scenarios to test, not present-day failings of the reference product.

## Flows and what remains unknown

| Area | Interpretation / evidence limit | Original response |
|---|---|---|
| Main journey | INFERRED: catalogue clothes → assemble/suggest → plan/wear → inspect use. Exact taps and account setup are unknown. | PROPOSED: start with three useful items, then build a first outfit. |
| Screens/navigation | INFERRED: feature families imply inventory, outfit, calendar and statistics views. No private screen inventory was observed. | PROPOSED: four primary destinations with secondary settings and statistics. |
| Item creation | INFERRED: photo and metadata need review. Mandatory fields, validation and image pipeline are unobserved. | PROPOSED: require title/category/photo; progressive disclosure for optional details. |
| Outfit creation | INFERRED: the calendar and suggestions need item combinations. Editing gestures and persistence are unknown. | PROPOSED: ordered slots and accessible selection buttons; no drag-only canvas. |
| Wear/calendar/statistics | INFERRED: measurements need dated use records. Counting rules and price conversions are unknown. | PROPOSED: distinguish planned from worn; count one item per local day; no invented FX conversion. |
| Weather/trips | INFERRED: destinations and weather likely inform packing. Consent, cache and failure behaviour are unobserved. | PROPOSED: city-only opt-in weather; trips after the MVP. |
| Background removal | INFERRED: polished product photos may involve segmentation or enhancement. Its internal implementation was not studied. | PROPOSED: crop/compress locally; defer segmentation until phone performance is demonstrated. |
| Privacy | INFERRED: store disclosures cannot establish default visibility, deletion completeness or security controls. | PROPOSED: owner-only data, no trackers and no account connections. |

## Opportunities translated into requirements

All points below are **PROPOSED** and are design choices, not allegations about another product.

* Keep user choice central: indoor/outdoor context, optional accessories, persistent disliked pairs and readable suggestion explanations (`R09`, `R25`).
* Make entry forgiving: retain an unsaved draft during a failed request, show the upload stage, and never duplicate an item after a retry (`R04`, `R23`).
* Keep plans editable without silently adding wear counts (`R07`, `R08`).
* Keep all accounts, photographs and derived statistics independent at the database boundary (`R01`, `R11`, `R12`).
* Keep the application useful during a weather outage or when no AI provider exists (`R09`, `R24`).

No usability testing of the reference app was performed. Screenshots were not reproduced or used as layout templates. The original visual language and all user-facing copy in this blueprint were designed for independent private use.

## AI supplement - 6 September 2026

The user approved paid automatic clothing tagging and chose **deterministic outfits**. The observations below describe public product claims, not undisclosed implementation. `20` defines our pre-save workflow; the fresh Google/OpenAI/Anthropic/Mistral comparison and primary-source links are in `21-AI-MODEL-COMPARISON.md`.

| Source | Public claim / evidence limit |
|---|---|
| [Official support](https://www.acloset.app/support/) | Says clothing uploads receive automatic background removal and attribute detection. AI Styling considers the closet, weather and occasion; users can adjust conditions, describe preferences and select categories to complete. It states that accurate clothing attributes and image quality affect results. These are company claims, not measured accuracy. |
| [Official product overview](https://www.acloset.app/llms-full.txt) | Describes computer vision, garment detection/segmentation, category tags, generative photo enhancement and personalized styling using weather, occasions, colour coordination and fashion rules. High-level product description, not source code or a model card. |
| [Version 6.30.0 announcement, 30 July 2026](https://www.acloset.app/announcements/6-30-0-1785377094985/) | Says location, time, day and weather inform recommendations; users can choose categories to complete around selected garments. No evaluation method or exact ranking algorithm is disclosed. |
| [Official styling article, 9 February 2026](https://www.acloset.app/magazine/ai-styling-has-come-this-far-how-digital-closet-ai-changes/) | Describes conversational styling and learning from wearing patterns and like/dislike feedback. Does not establish whether learning means prompting, stored preferences, statistical ranking or model fine-tuning. |
| [Official privacy policy, effective 29 April 2026](https://www.acloset.app/privacy/) | Covers uploaded images, AI chat and service providers including image-tagging providers. Does not identify a specific image model or inference company. Its Gmail-specific training restriction must not be generalized to all photos/chats. |

The homepage's explicit category/colour/season/pattern list appears in its browser-extension import section; do not present that list as a verified schema for every mobile upload. The support page separately confirms automatic photo-attribute detection. Public editing guidance is not proof of every tag-correction interaction.

**Finding:** the reviewed official sources describe AI-driven clothing understanding and contextual styling. They do not name the production foundation models or establish whether final outfit selection is deterministic, LLM-only or hybrid. Do not claim that the product uses Gemini, GPT, Claude or our proposed architecture.

**Our decision, updated in revision 1.3:** one image-understanding model fills an editable draft, including title/category, before explicit Save to library. The rule engine uses saved reviewed attributes only. No need to copy beautification, chat, social feeds or multi-garment segmentation.

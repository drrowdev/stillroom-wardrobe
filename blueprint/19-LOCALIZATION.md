# English, Finnish and Swedish

Blueprint revision **1.1**, 5 September 2026. **R27 is MVP scope.** This adds interface language support to the blueprint; no production app has been implemented. The accounts remain completely independent.

## Language and account contract

| UI language | Stored code / native selector label | Formatting locale |
|---|---|---|
| English | `en` / English | `en-GB` |
| Finnish | `fi` / Suomi | `fi-FI` |
| Swedish | `sv` / Svenska | `sv-FI` |

Use Swedish as used in Finland for default formatting. Language does not select a country, change EUR to SEK, change timezone, move calendar entries or affect suggestion eligibility. Existing timezone/currency settings remain independent.

`profiles.ui_language` is nullable text restricted to `en`, `fi`, `sv`. Null means no saved choice yet, not a fourth language. On sign-in, use this precedence: the authenticated owner's saved preference → an explicit language selected on the current sign-in screen → the first supported language in `navigator.languages` → English. Match regional variants by their primary subtag (`fi-FI` → `fi`, `sv-SE` → `sv`); skip unsupported entries. Do not request location or infer language from an email/name.

Put a text-labelled language selector on S01 Sign in and in S02 Profile/S12 Settings. Show native language names, not flags. A signed-out choice exists only in memory and does not change an account. After the first successful login with a null preference, save the resolved language to that owner only with a version-checked PATCH; if a concurrent save wins, use its value. A failed initialization leaves the interface usable and offers retry, without claiming the setting was saved.

Changing language while signed in updates that owner's profile through the existing RLS/version contract. Apply the new UI after a successful save, without reloading, discarding drafts or changing Auth. Offline, disable the persisted setting and explain the connection requirement. On logout/UID change, clear the previous owner's language state along with private state, reset to browser negotiation and wait for the next owner's profile before rendering protected content. Do not put a profile's language preference in a device-global localStorage key, URL or log. Static translation dictionaries may be shell-cached; they contain no user data.

## Translation implementation

Use the existing three browser runtime dependencies only. Add `src/i18n/messages.json`, typed translation/formatting helpers and a small context/provider; localization itself uses no paid translation service, remote dictionary, extra i18n package or AI call. The separate server-side tagging feature in `20` is allowed. `reference-scripts/locales.json` provides starter strings as `{messageKey:{en,fi,sv}}`; copy/adapt it into typed application helpers.

Every new screen must extend all three language values in the same PR. The supplied catalog covers core flows and common taxonomy; it is not a claim that every future control already exists. Translate navigation, forms, onboarding, buttons, units, field errors, empty/loading/offline states, confirmations, privacy/deletion/backup warnings, status badges, recommendation reasons and accessible labels. Include install guidance and tooltip/aria text. Keep the internal product name Stillroom Wardrobe unchanged.

Use whole sentences with named parameters, never concatenated sentence fragments. For example `suggestion.temperature` takes `{temperature}` after locale formatting. Use `Intl.PluralRules` and explicit `_one`/`_other` messages for counts. All three languages use this cardinal pair for the counts supported by the app. Render text through React text nodes; never interpret translations or interpolated item names as HTML. No `dangerouslySetInnerHTML` for translated content.

CI fails on a missing/empty language value, unknown message key, mismatched parameter names, invalid plural pair or raw user-facing string outside the catalog. At runtime an unexpectedly missing translation falls back to its English value, then a generic localized error; never display an internal key. Development should fail loudly so fallback does not hide incomplete translations. Public pages set `<html lang>` to the active `en`, `fi` or `sv` value; language changes update it immediately when the setting is applied.

## Stable data and formatting

* Keep schema/table/JSON keys, UUIDs, enum values, color/category identifiers, routes, error codes, signatures and export filenames language-neutral. Store `top`, not `yläosa` or `överdel`. Translate only the displayed label. Never add one set of wardrobe tables per language.
* Keep user-entered names, brand/size/material/free-text tags, notes, descriptions and historical text exactly as entered. Do not auto-translate them or send them to any provider. Initial generated labels may use the current language when first created; after saving, they are ordinary editable content, not silently rewritten by a language switch. Existing bootstrap display names such as `Me` remain editable profile data.
* Return recommendation reason keys plus parameters from the engine; render them in the current language. A language switch changes explanations, never candidate IDs, scores, feedback signatures or recommendations. Canonical UUID ordering and export serialization do not use a UI-language collator.
* Use `Intl.NumberFormat` with the formatting locale for counts, decimals, temperatures and money. Currency is always `profiles.currency` or the item's recorded currency. Keep SQL decimal strings/ISO dates and arithmetic unchanged. Finnish/Swedish price entry accepts decimal comma; the reference parser also accepts an unambiguous decimal point, validates grouping and rejects ambiguous/malformed input. Never send a formatted currency string to SQL.
* Use `Intl.DateTimeFormat` for presentation. Date-only wear records remain their stored `YYYY-MM-DD`, independent of timezone conversion. The reference formats them with a UTC-only calendar-date helper. Format real timestamps using the owner's saved timezone. Use a Monday-first calendar and 24-hour time in all three locales.
* Normalize search strings to NFC and use locale-aware case folding and `Intl.Collator` for displayed title ordering, with UUID as a stable tie breaker. Preserve Nordic letters `å`, `ä`, `ö`; do not strip them to ASCII. Search the owned user text and current localized category/color labels. Never use locale-dependent ordering for IDs/hashes or request another account's data to translate results.

## Schema and backup compatibility

Fresh repositories use revision 1.1 of `07-DATABASE-AND-RLS.sql`. If revision 1.0 was already applied, keep that migration immutable and add `reference-scripts/20260905000001_languages.sql` as a new migration, once. Do not run both routes on the same schema or reset an existing project. Regenerate database types. No new RLS policy is needed: the profile preference inherits the existing owner-only policies.

The existing `export_manifest` includes the profile column automatically. Keep the version-1 export envelope, since this profile field is additive and optional to import. Update the v1 profile allowlist to accept `ui_language`; an older backup missing the field normalizes it to null in the import plan. Verify hashes against the original manifest **before** normalization. Reject unsupported values rather than importing an unknown locale. New exports preserve the preference; restore keeps the target's current profile/language by default, changing it only through the explicit existing profile-merge choice. This never creates an account relationship.

For the AI extension, `20` requires metadata schema v2 while retaining envelope v1/v1 import support. Export saved values/provenance only, never unsaved drafts or request results. Do not import active AI consent.

I29 adds pre-save analysis, Review details, Save to library, Discard, Continue manually, not-detected/estimated/expired-result and cost/retention text, plus pattern/length labels. The 234-key reference catalog predates this work. Every garment field remains editable in the same localized form; no per-field confirmation checklist.

AI returns canonical attributes, not UI translations. Generate an editable title/description once from known attributes using the current locale; the generated text becomes ordinary draft/personal content. A Finnish generated title stays Finnish after a language switch unless the owner edits it. Never silently overwrite it, translate personal fields or rerun analysis on a language change. All three languages must explain that analysis happens before Save and may be charged even if discarded.

## Implementation order and acceptance

| Phase / issues | Required addition |
|---|---|
| 0 / I01–I05 | Catalog/helpers and `check:translations` gate; three-language sign-in/wardrobe/upload slice; independent saved preference and RLS tests. First prompt includes this scope. |
| 1 / I06 | Profile/settings selector, save errors, version conflicts and A=Finnish/B=Swedish persistence without carryover. |
| 2–6 / existing feature packets | Translate each implemented feature in its own PR, including search labels, explanations, calendar/statistics and export/restore/deletion. Preserve identifiers and owned data. |
| 7 / I24–I25 | Review every MVP screen in all three languages; native-speaker wording review, 320 px/200% text, focus, VoiceOver/TalkBack, fallbacks and no untranslated critical text. |

`tests/unit/i18n.test.ts` covers negotiation order, region variants, unsupported fallback, interpolation, plural counts 0/1/2, Nordic text, decimal parsing, currency and date invariance. `tests/browser/localization.spec.ts` runs the core journey in `en`, `fi`, `sv`, checks `<html lang>`, critical text and narrow layouts; A's language change must not alter B's profile or leak into B's session. `tests/security/rls.sessions.mjs` proves cross-owner language changes have no effect using real normal sessions when configured.

Run `npm run check:translations` in every CI build alongside existing checks. `validation/check-localization.mjs` is an executable reference check for the delivered catalog/helpers. Passing it validates those references only, not an unbuilt app or professional language review. No new service fee or language-related network call is introduced; remeasure the initial bundle after adding the small static catalogs.

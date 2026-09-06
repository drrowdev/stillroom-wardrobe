# Product requirements

Build a calm wardrobe app with two completely independent accounts. Each person uses only their own clothes, preferences and history. There is no household, partner link, directory, invitation from one account to another, or sharing relationship.

**User A** wants quick capture, casual/everyday suggestions, clear ownership and low operating cost. **User B** has independently chosen preferences, an independent login, and exclusive control of their own data. Neither persona assumes gendered categories, body measurements, medical information or the same taste. English, Finnish and Swedish are MVP interface languages, chosen independently by each account. Metric temperatures, Europe/Helsinki and EUR remain defaults; a language change never changes timezone or currency.

## Requirements and acceptance criteria

Each ID maps to screens, tables, operations, issues and tests in `12-TEST-STRATEGY.md`. The acceptance criteria here are the release contract.

`19-LOCALIZATION.md` defines the shared implementation contract for language requirement R27, including translated critical warnings, native formatting and unchanged personal text.

| ID | Requirement | Acceptance criteria |
|---|---|---|
| R01 | Two invited accounts | Public/anonymous signup disabled. Only two reserved emails can create Auth identities. A third email fails admission. A and B pass the negative access suite with normal logins. |
| R02 | Independent profiles/preferences | Each member edits only their display name, valid IANA timezone, currency, style/colour and coverage preferences. Active account name is visible on every protected screen. |
| R03 | Complete wardrobe CRUD | Capture every field listed below. Create, edit, favourite, availability change, archive/donate/sell, trash, undo and permanent deletion work without affecting the other user. |
| R04 | Private image capture | Camera/library photos undergo validation, crop, orientation correction, resize, metadata-free re-encoding and thumbnail creation before upload. Byte-level EXIF/GPS tests pass. Never upload the source file. |
| R05 | Search/filter/sort | Search title, brand and tags; combine category, colour, season, formality, availability, lifecycle and favourite filters. Sort by newest, name, least worn, last worn and price within currency. Results contain only own records. |
| R06 | Manual outfits | Select 1–12 owned items, order with buttons, name and save an outfit. Missing/trashed components are indicated. Editing an outfit does not rewrite previous wear records. |
| R07 | Calendar and history | Add multiple plans/looks to one local date. Explicit “Mark worn” converts a plan. Future dates cannot be worn. Undo/edit/delete history recalculates statistics. |
| R08 | Useful statistics | Show item wear count, last worn, unworn active items and cost per wear. Repeated events on the same local date count once per item. Zero wears and unknown price display an em dash. Currencies remain separate. |
| R09 | Explainable recommendations | Generate at most three ranked outfits from eligible items, honour hard exclusions, explain two or three leading reasons, and identify missing slots rather than invent garments. Weather outage never blocks manual use. |
| R10 | Optional weather | Weather is off until a city is chosen and enabled. Use rounded city coordinates, never GPS permissions. Show forecast date/freshness and manual override. Revoking consent clears city/cache if requested. |
| R11 | No connection between accounts | No household/partner membership, peer directory, sharing grants, recipient columns, borrowing, cross-account references or discovery endpoints. An account can neither see nor address the other account in the app. |
| R12 | Owner-only media access | Image upload, listing, download, replacement and deletion require the active owner. No public bucket or sharing URL feature. Cached private bytes are cleared on logout; deliberate owner-created diagnostic bearer links expire independently. |
| R13 | Personal export | Export the current user's owned metadata and sanitized images in a versioned, checksum-verified format. Credentials, other users’ data and session tokens are excluded. |
| R14 | Safe restore | Dry-run validates schema, sizes, hashes and relationships. Restore binds every record to the currently authenticated owner, remaps IDs and never creates a cross-account relationship. Re-running an import is idempotent. |
| R15 | Account deletion | Recent password reauthentication and a deliberate confirmation start resumable deletion. Freeze the account, remove its images, private rows and Auth identity. Show partial failure and retry; other member remains intact. |
| R16 | Mobile PWA and offline states | Works in current iOS Safari and Android Chrome, installed or in browser; usable at 320 CSS px. App shell is cached. Private data is not persisted offline. A disconnected session shows explicit unavailable/stale states and blocks remote commits. |
| R17 | Accessible operation | WCAG 2.2 AA is the implementation target. Keyboard and screen-reader paths cover capture alternatives, item editing, outfit ordering, export and deletion. 200% text resizing and visible focus work; touch targets are at least 44×44 CSS px. |
| R18 | Controlled operating cost | Prefer free infrastructure; paid automatic tagging is allowed within explicitly configured per-account allowances. Enforce server-side reservations and bounded requests/retries; stop new calls at the allowance. No automatic plan upgrades. Budgets are in `11` and `20`; backups remain outside the live project. |
| R19 | Secrets/log minimisation | Browser only receives project URL and publishable/anon key. No service secret or JWT signing key in source, bundle, logs, source maps or client errors. No analytics SDK, ads or third-party fonts. |
| R20 | Recoverable operation | Each person has a weekly encrypted backup procedure, 7-day trash and a verified quarterly restore drill. Operator migration copies database structure and actual image bytes separately. |
| R21 | Practical performance | At 500 items per person, load only the first 40 thumbnails; local recommendations stay under 200 ms on a representative phone. Pre-save analysis has a bounded timeout/manual fallback and does not freeze the editable form. Measure its latency separately. Target LCP <2.5 s with no sustained layout jumps. |
| R22 | Original product | No reference-product name in repository name, application source or UI; no copied assets, text or screen compositions. Research attribution may name the reference in documentation. |
| R23 | Predictable retries/concurrency | UUID request IDs prevent duplicate creates. Version-checked edits return a recoverable conflict. Upload retries preserve identity. Destructive operations are not retried blindly. |
| R24 | Replaceable optional providers | A disabled enhancement provider returns “unavailable” without making a request. The app and rule engine work with the provider absent, rate-limited or out of credit. |
| R25 | Durable suggestion feedback | “Wear more” changes the owner's item bias; excluded items never enter candidates; canonical disliked pairs are never combined; feedback does not expose the spouse's preferences. |
| R26 | Immediate membership freeze | Disabling the admission slot blocks new RLS/media operations even with an unexpired access token. Signing out clears caches, object URLs and session storage across tabs. |
| R27 | English, Finnish and Swedish | All implemented screens, errors, confirmations, explanations and accessible labels support `en`, `fi`, `sv`. Each owner saves only their own language. Saved preference/sign-in/browser/English fallback is deterministic. Locale formatting preserves dates, money values, currencies, timezone, identifiers and personal text; catalog parity and account-reset tests pass. |
| R28 | Photo-first editable AI draft | After owner setup consent, a prepared photo automatically fills a draft including title/category. Every garment field is editable before explicit Save to library; no library item/image is created by analysis or discard. Preserve manual edits/clears, reject stale responses and keep unsupported facts unknown. Timeout allows manual completion. No post-save AI mutation; owner isolation, budgets and receipts follow `20`. |

## Item fields

Required to **start**: a photo only. AI fills the form, including title/category, without requiring the user to type them first. Required at **Save to library**: photo, valid title and category, whether automatically filled or edited. Every garment field and the photo description can be reviewed/edited before Save and afterward. Missing optional facts stay blank/unknown.

Before Save, keep only a session-memory draft and the short-lived owner analysis receipt; no item or private image object exists in the library. After explicit Save, an incomplete upload reservation may exist for retry but must not appear as completed inventory or feed suggestions/statistics. Base SQL's non-null saved-item title/category constraints can remain.

Optional details: subcategory; up to three colour names; pattern, sleeve/garment length; brand; size label; material; one or more seasons; formality 0–4; purchase date, nonnegative price and ISO currency; notes; favourite; availability (`ready`, `laundry`, `repair`, `lent`); lifecycle (`active`, `archived`, `donated`, `sold`); up to twelve tags. Recommendation helpers: warmth 0–4, optional temperature range, rain rating, windproof, coverage, style tags, exclude and wear-more flags. `20` specifies which details AI can fill, observed/estimated/unknown provenance and manual precedence. Unentered physical properties must not become factual numeric defaults. I29 adds the necessary migration; the supplied base SQL does not yet express this distinction.

`active` is not synonymous with `ready`: an active shirt in the laundry stays in the wardrobe but cannot be suggested. Trash is separate from lifecycle. Ownership cannot be reassigned. An outfit contains only owned items. Recommendations have no input type or option for another account’s content.

## Release success

Each user can start with a photo, receive an automatically filled form, edit any garment detail and explicitly save three clothes. Discarding creates no inventory; saving preserves exactly the reviewed values. Each can create/wear an outfit, obtain deterministic suggestions and restore without AI charges. Accounts remain invisible to one another. Provider failures allow manual draft completion, not invented tags or a false successful save.

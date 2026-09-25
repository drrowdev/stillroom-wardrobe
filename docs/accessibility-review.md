# Accessibility and responsive review (I24)

Status, Phase 7 PR-2: **automated checks complete; owner/device gates pending.**
Requirements: R17 (accessibility), R22 (languages), R27 (responsive PWA).
Base `12f472fe`. Plan: Phase 7 rev1 §I24 with rev2 amendment 8 (P6c and
service-worker surfaces), approved with rev3–rev5.

This file records what the automated suites check and what still needs a
person or a real device. A pending gate is not a pass.

## What every I24 check does

`tests/browser/accessibility.spec.ts` (dev build, Chromium desktop and the
iPhone-sized `mobile` project) and the I24 block in `tests/pwa/visual.spec.ts`
(production build with the service worker) run each surface in English,
Finnish and Swedish. For every state they:

- assert `<html lang>` matches the chosen language;
- at a 320 px wide viewport, and again with 200% text, fail on horizontal
  scrolling, text that does not fit its box or runs past the viewport, and
  touch targets under 44 × 44 px (checkboxes and radios are measured by their
  label);
- run axe with its default rules, which include colour contrast, on the whole page;
- where the surface has controls, press Tab through them and require DOM
  (reading) order, no positive `tabindex`, and a visible focus ring (outline of
  at least 2 px or a box shadow) on every stop.

The production CSP blocks injected style sheets, so the PWA block applies 200%
text through the CSSOM instead of weakening the policy.

## Surfaces

| Surface | States checked | Where |
| --- | --- | --- |
| Settings, including the install hint | page; leave dialog with focus on Continue editing | accessibility.spec |
| Install hint (production) | card at 320 px/200%, platform-specific text, hidden when installed | pwa/visual.spec |
| Update banner (production) | banner at 320 px/200%; Reload ≥44 px, reached by Tab, visible focus | pwa/visual.spec |
| Backup | passphrase form, focus on the passphrase field | accessibility.spec; backup.spec |
| Delete account | password, confirmation, typed phrase; wrong password (reauth) alert takes focus | accessibility.spec; delete-account.spec |
| Deletion recovery screen | `retry`, `in_progress`, `contact`; interrupted deletion resumed, status announced, password cleared | accessibility.spec |
| Item detail | editor; leave dialog | accessibility.spec; item-details.spec |
| Add item | photo draft with manual fields; discard dialog | accessibility.spec; slice.spec; ux-l1a.spec |
| Trash | Undo notice; Trash page; permanent-delete confirmation | accessibility.spec; items.spec |
| Outfit editor | editor after keyboard reordering; leave dialog | accessibility.spec; outfits.spec |
| AI consent and privacy notice | card with full details open | accessibility.spec; ai-photo-first.spec; ux-l2a.spec |
| Sign out | focus moves to the sign-in heading; sign-in page | accessibility.spec |
| Password recovery | confirmation step; new-password form | accessibility.spec; recovery.spec |
| Main routes (Today, Wardrobe, Outfits, Settings, Trash, sign-in) | each route | release-sweep.spec |
| Restore, weather, Today states, wardrobe grid | each state | restore, weather, today, wardrobe-grid specs |

## Keyboard alternatives

- **Crop:** arrow keys move the frame, the other crop controls are ordinary
  buttons in reading order, and the status announces the settled frame and
  orientation.
  `images.spec` "I07 crop accessibility…" and `ux-l1b.spec` T8/T9/T14.
- **Outfit order:** each slot has Move up/Move down buttons; focus follows the
  moved item and the order change is announced. `outfits.spec` "I11 outfits
  accessibility…" and the new I24 outfit test, which moves an item with Enter
  and checks focus and the new order.

## Translated warnings

A unit-style check in `accessibility.spec` fails if any recovery, deletion,
backup, AI privacy, profile privacy, weather consent, install or update
message is empty or identical to English in Finnish or Swedish. It checks
that the text exists, not that it reads well.

## Fixes in this PR

- Time-zone labels used the browser locale's wording, so English showed
  "Helsinki (GMT+3)" and Finnish "Helsinki (UTC+3)". All three languages now
  show "Helsinki (UTC+3)" (with "UTC+5:30" and "UTC−5" forms).
- `.text-button` now has a 44 px minimum width. Back, Undo and the Trash link
  were 30–35 px wide.
- Dialogs no longer break words letter by letter. Action buttons stack at
  widths up to 650 px (which includes 200% text on phones). Titles stay
  text-relative (`1.375rem`, one smaller rem step below 360 px), so they
  still double with 200% text. Titles and buttons wrap only between words; a
  word breaks (`overflow-wrap: break-word`) only when it is wider than the
  whole dialog.
  Dialogs scroll inside the viewport (`100dvh`), so every action stays
  reachable. The delete-account confirmation now uses the same dialog action
  layout.
- The skip link is hidden with a transform, so the wrapped Swedish link no
  longer shows over the header at 200% text.
- New checks: a dialog title or button word split across lines fails unless
  it is wider than the dialog and its title or button fills its row (synthetic
  pass/fail cases prove both sides); the dialog title must grow at least 1.9× with
  200% text; each dialog action must be scrolled into view and hit-testable.
  On signed-in screens there must be exactly one skip link, off-screen until
  focused, the first Tab stop, fully visible with a focus ring, and Enter must
  move focus to `#main`; signed-out screens have none. The split-word,
  title-size and skip-link checks each fail on the earlier CSS.
- The update banner wraps, so Reload ("Lataa uudelleen") no longer clips at
  200% text.

## Captures for visual review

CI artifact `i24-a11y-ui-<head>`, all at 320 px with 200% text: Finnish
Settings leave dialog, Finnish Delete account card after the wrong-password alert,
Swedish outfit leave dialog, Swedish deletion recovery after a resumed
attempt, and the Swedish update banner. The coordinator reviews them; this
session does not open images.

## Pending owner and device gates

These are not covered by automation and are **pending, not passed**:

1. **VoiceOver** (iPhone/iPad Safari, installed and in the browser): sign-in,
   Add item with a photo, crop, Save, outfit reordering, delete account and the
   update banner. Owner/device gate.
2. **TalkBack** (Android Chrome): the same journey. Owner/device gate.
3. **Native-speaker wording review** of Finnish and Swedish, especially the
   recovery, deletion, backup and AI privacy warnings. Owner gate.

axe cannot judge every contrast case (text over images, gradients) and
automated checks cannot judge whether announcements make sense when heard, so
these gates stay open until someone records a result here.

# Owner release checklist (R1)

One ordered session per owner, on the owner's own account, on both target phones:
iPhone Safari and Android Chrome. Run it only after the release candidate C is
deployed and read back (a new D row in [release-gates.md](release-gates.md)). The
steps link the existing runbooks instead of repeating them.

## Before you start

- In Settings, the version label must equal the first 8 characters of C. If it
  doesn't, stop: the phone is not running the candidate.
- Note whether photo clean-up and try-on are turned on for your account.

## Reporting

Send one line per step and phone:

```
step · gate · phone · PASS | FAIL | NOT ACTIVE | NOT DONE · numbers · note (at most 2 lines)
```

- Report outcomes and measurements only. No photos, screenshots, garment
  descriptions, names, email addresses or backup contents.
- A step or sub-step you didn't do is `NOT DONE`, and its ledger row stays
  **BLOCKED**. It is never counted as a pass.

## Clean-up and try-on

Steps 4 and 5 only count after activation, which happens in this order:

1. the approved probe (clean-up: the BG2c-3 check calibration; try-on: the
   owner-approved probe);
2. a follow-up R1 at a new candidate C′: a CI receipt that passes for C′, the
   Pages deploy of exactly C′ with its read-back D row, and the Edge-source
   comparison;
3. a separately approved activation, recorded in the ledger;
4. steps 4 and 5 below, run after activation.

If they are not active at this R1, report `NOT ACTIVE` for steps 4 and 5. That is
neither an acceptance nor a waiver: O13 and try-on acceptance stay **BLOCKED**
until you report steps 4 and 5 after activation.

## Steps

Each step is on both phones unless it says otherwise.

1. **O1: install and offline reopen.** Add the app to the home screen, open it,
   turn on airplane mode and open it again. From a laptop, run `curl -I` on `/`
   and `/service-worker.js`. Checklist:
   [#60 c5835812872](https://github.com/drrowdev/stillroom-wardrobe/pull/60#issuecomment-5835812872).
   Report PASS/FAIL per phone and the `content-type` and `cache-control` lines.

2. **O8: the release journey**, in the order in
   [operations.md](operations.md#restore-drill-i26): sign in, language, add from a
   photo with Save, search, an outfit, Today, a backup with offline verify, the
   offline notice, sign out.
   - **After sign-out**, reopen the app online and offline. No wardrobe item,
     photo, name or email may appear, and the browser Back button shows only the
     signed-out screen.
   - Report PASS/FAIL and the step that failed.

3. **P1 (image), O11 and P2**, on 3 real garments: the photo add in step 2 and
   two more.
   - **P1 (image):** take a full-size camera photo, crop, prepare and upload.
     Record the seconds from capture to the prepared photo, the seconds for the
     upload to finish, whether the tab reloaded or closed, and any error line.
   - **O11 G1 (quality):** edges, a light garment on a light background, a
     patterned garment.
   - **O11 BG2a (framing):** a trimmed sleeve, strap or hem; a garment
     off-centre because of a shadow; wrong padding.
   - **O11 G2 (timing):** seconds from the tap to a usable cut-out, not counting
     the first model download (report that separately).
   - **P2 (analysis):** seconds from the moment analysis starts (the analysing
     status appears) until the filled draft can be edited, **before** Save to
     library. Measure it separately from preparation and clean-up, and note
     whether the form stayed editable the whole time. On Android use Chrome remote
     DevTools (USB): the Network timing of the `analyze-clothing` request plus the
     moment the fields fill. On the iPhone use a stopwatch and mark it
     *ballpark*.
   - Gate details: [release-checks.md](release-checks.md#owner-and-device-gates-pending-not-a-pass).

4. **O13: clean-up first use.** After activation only (see above). On 3 real
   garments, against the owner's clean-up policy (row A7: block only gross
   changes):
   - the "Edited with AI" label, Keep original, and the fallback line when a
     result is refused. If no refusal happens, report "fallback not seen": that
     sub-step stays **BLOCKED**.
   - Before activation: report `NOT ACTIVE`. O13 stays **BLOCKED**.

5. **Try-on first use.** After activation only. One saved outfit with your own
   photo: progress, Stop, the result with "Made with AI" and its keep-until date,
   Delete, and the monthly figure in Settings.
   - Before activation: report `NOT ACTIVE`. Try-on acceptance stays **BLOCKED**.

6. **P1: suggestions with 500 items.** Run `npm run bench:engine` from a clean
   checkout of C (the tool is added in R-6a; until then this step is `NOT DONE`).
   It uses fictional data only and needs no account.
   - **Android:** the page is served on the laptop's 127.0.0.1; open it on the
     phone through Chrome remote DevTools port forwarding.
   - **iPhone:** only if you agree to it, `--lan` serves it on one private
     address for 15 minutes. If you don't, iPhone P1 stays **BLOCKED**.
   - Report the full SHA the page shows, the phone model, the fixture settings,
     the five slowest-context times in ms, the median, and PASS/FAIL against
     200 ms. A result that doesn't show C's SHA doesn't count.

7. **P3: first load on mobile data.** Close the app, turn Wi-Fi off, and open it
   cold.
   - Time from the tap until the wardrobe can be used, with a stopwatch. This is a
     *ballpark*, not a measured LCP.
   - Did anything jump or move after it appeared? Answer yes or no, and where.

8. **O7: hosted H1**, on a laptop: create a backup, run `verify-backup`, run
   *Check backup* up to the plan, then close it
   ([operations.md](operations.md#hosted-operations)). Report counts, bytes and the
   manifest SHA-256 only.

9. **O2 and O4: screen readers.** VoiceOver on the iPhone and TalkBack on Android
   over the step 2 journey (runbook step 10), by you or a tester. Report PASS/FAIL
   per phone and anything that couldn't be reached or read.

10. **O9: ten real decisions.** Start today and finish over the next days. For
    each real outfit decision, record whether the suggestions helped (yes, partly
    or no) plus one word. Report the ten lines.

## Not in this session

- **O3:** Finnish and Swedish wording needs native speakers.
- **O5:** deferred by the owner. This doesn't complete the second owner's O8:
  O8 closes only when each owner has reported their own journey.
- **O10:** a recorded deviation.
- **O6:** comes last, after every other O, P and V row is closed.

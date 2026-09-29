# MVP and non-goals

The first release is **Phases 0–7**. Phase 0 is a secure vertical slice; it is not the complete MVP. Do not expose incomplete later screens as working features. Each later phase starts only after its predecessor's completion evidence is recorded.

## Included

Two invited logins; independent profiles/preferences; camera/library image capture; crop/orient/resize/compress and remove metadata; automatic editable AI clothing details after upload, with manual metadata and lifecycle controls; filtering/search; manual outfits; plans and wear history; wear statistics; deterministic suggestions and feedback; optional city weather; no account relationship or sharing; personal exports, restore and deletion; encrypted backup tooling; installable responsive PWA and accessible states. 24 Sep 2026: I12/I13 calendar, wear records and wear counts/cost-per-wear moved to backlog by owner decision; PR #37 comment 5815445262.

**Approved revision 1.3:** paid AI automatically fills an editable form from a photo, including title/category. The user can edit every garment field before explicit Save to library; analysis never automatically saves an item. One-time provider consent replaces a separate "Suggest" action, not the final Save. This supersedes revision 1.2's post-save enrichment. Outfits stay deterministic. `20` defines the revised I29 contract.

Background removal is automatic and runs on the device (ADR24, owner request #84). After the crop, a small open segmentation model (u2netp, Apache-2.0) replaces the background with the warm neutral colour before the normal encode and checks, and the garment is centred on a 4:5 canvas with even padding (BG2a). The model and its runtime (about 19 MB) download from the app's own origin on first use and are cached; no photo or pixel leaves the device for this. If removal fails, times out or cannot download, the photo keeps its original background and the flow continues. Rotation and manual framing stay. Optional AI photo enhancement (ADR26, BG2b) redraws the cut-out with a paid image model after separate consent; it is built but inactive until the owner activates it, the user can go back to the original before Save, and any failure keeps the cut-out. `ImageEnhancementProvider` remains a disabled interface for anything beyond this. Details are in `05` and `08` step 9. It was not in the initial release: it was added after the owner's request, and real-garment quality and phone timing remain owner gates.

## Deferred Features

**22 September 2026, approved I10 split:** routine pending/retired/orphan
maintenance and its blocked evidence tools are user-deferred as **I10a-D**,
not passed. This narrow deferral does not remove R04 capture/privacy, explicit
Save, checked replacement with current-photo survival, seven-day recovery into
a new identity without inference, or R03/R12/R15 explicit deletion requirements.
I10b therefore includes the deletion compatibility needed to handle pending and
unmanifested objects under an owned item prefix. It is not a general sweeper.
I22 still requires exhaustive owner-prefix removal in Phase 6; I11 is not yet
eligible. Minimum-release reconciliation uses this dated decision, not an
implicit waiver of deletion, backup, recovery or security.

| Feature | Stage / reason |
|---|---|
| Trips and packing lists | Optional Phase 8, after MVP acceptance. Useful but adds date/destination/checklist state. Specify owned trips and item references only; no collaborative trip editing. |
| Local background removal | In scope (ADR24): automatic, on the device, with automatic fallback to the original background. Real-garment quality and iPhone/Android timing are owner gates. |
| Native Expo app or native wrapper | Only after a measured PWA limitation blocks daily use; would add distribution/signing and another platform test burden. |
| Push notifications | No recurring reminders in the first app; browser installation/permission differences add work without wardrobe value. |
| Persistent private offline wardrobe | Requires encrypted device storage, explicit device trust, eviction and revocation design. Shell-only offline support is intentional. |
| Any sharing, borrowing, peer discovery or connected accounts | Explicitly excluded by the user’s later instruction. Do not implement or defer as an expected next feature. |
| AI outfit reranking or conversational stylist | Not selected for the first release. Evaluate only after a later request and evidence that it improves on deterministic matching using the AI-tagged catalog. |
| Generative image generation other than try-on | Significant cost and additional sensitive imagery; no need for the core use case. Virtual try-on of a saved outfit is no longer a non-goal (owner decision #84 c5873753380, ADR28): VTO-1 adds its inactive backend and VTO-2 its UI, each behind separate owner gates. |
| Always-on AI chat | Paid and operational complexity; explainable suggestions already address daily choice. |
| Public feeds/profiles, followers, likes/comments | Incompatible with a private two-member scope. |
| Marketplace, payments, advertising/subscriptions | No business model or commerce requirement. |
| Retailer connections, inbox scanning, purchase imports | Excessive permissions and integration maintenance for two people. |
| Household/group membership, partner roles and user invitations | Explicitly excluded. Administrative approval of independent logins is the only admission mechanism. |
| Body/face photos, biometric style diagnosis | Not needed for inventory or rules; no inference of body traits. |
| Automatic currency conversion | Adds another provider and ambiguity; keep costs in their recorded currency. |

## Scope-control rules

1. A missing feature enters `18` or the explicitly labelled deferred backlog; it does not enter an MVP issue by implication.
2. `R01`–`R28` are MVP acceptance requirements, including localization and automatic tagging. Optional Phase 8 has `D01` and separate issues; no Phase 0–7 prompt implements it.
3. One deployment, one Supabase project and one browser client. Pre-save analysis uses an authenticated endpoint and short-lived request receipts, not a tagging worker/queue. No SSR, vector database, realtime subscription or additional application database.
4. Paid tagging is approved in scope, not activated by this document. Confirm the provider product/terms, account consent and finite allowances before requests. Native distribution and public user content remain excluded.
5. A phase may fix an earlier defect required for its exit gate; it may not silently broaden product scope.
6. Backup/restore/deletion and security are release requirements, not post-launch chores.

## Release milestones

| Milestone | Scope |
|---|---|
| Phase 0 | Auth + RLS + private upload + one wardrobe screen + CI in English/Finnish/Swedish; revision 1.1 base schema only, no AI calls |
| Phases 1–2 | Personal setup, reliable image capture, I29 AI-filled draft/review/Save and metadata migration, full wardrobe and filters |
| Phase 3 | Outfits, calendar, wear records and statistics (24 Sep 2026: calendar/wear records, I12/I13, in backlog by owner decision, PR #37 comment 5815445262) |
| Phase 4 | Rule engine and feedback |
| Phase 5 | Optional weather and full account-isolation verification |
| Phase 6 | Export, restore, account deletion and backup scripts |
| Phase 7 | Accessibility, device performance, security and recovery acceptance; MVP release |
| Phase 8 | Optional trips/packing, only if requested after MVP |

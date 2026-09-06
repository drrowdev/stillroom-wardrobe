# MVP and non-goals

The first release is **Phases 0–7**. Phase 0 is a secure vertical slice; it is not the complete MVP. Do not expose incomplete later screens as working features. Each later phase starts only after its predecessor's completion evidence is recorded.

## Included

Two invited logins; independent profiles/preferences; camera/library image capture; crop/orient/resize/compress and remove metadata; automatic editable AI clothing details after upload, with manual metadata and lifecycle controls; filtering/search; manual outfits; plans and wear history; wear statistics; deterministic suggestions and feedback; optional city weather; no account relationship or sharing; personal exports, restore and deletion; encrypted backup tooling; installable responsive PWA and accessible states.

**Approved revision 1.3:** paid AI automatically fills an editable form from a photo, including title/category. The user can edit every garment field before explicit Save to library; analysis never automatically saves an item. One-time provider consent replaces a separate "Suggest" action, not the final Save. This supersedes revision 1.2's post-save enrichment. Outfits stay deterministic. `20` defines the revised I29 contract.

The initial release deliberately has **no background segmentation model**. Automatic background removal is optional in the brief, and model download/phone memory/licence work does not justify delaying the useful app. A neutral crop background, rotation and manual framing are included. `ImageEnhancementProvider` is a disabled interface. The local open-source candidate and adoption test are documented in `05`.

## Deferred Features

| Feature | Stage / reason |
|---|---|
| Trips and packing lists | Optional Phase 8, after MVP acceptance. Useful but adds date/destination/checklist state. Specify owned trips and item references only; no collaborative trip editing. |
| Local background removal | Optional separate iteration after representative iPhone/Android benchmarks and licence review; app remains usable without it. |
| Native Expo app or native wrapper | Only after a measured PWA limitation blocks daily use; would add distribution/signing and another platform test burden. |
| Push notifications | No recurring reminders in the first app; browser installation/permission differences add work without wardrobe value. |
| Persistent private offline wardrobe | Requires encrypted device storage, explicit device trust, eviction and revocation design. Shell-only offline support is intentional. |
| Any sharing, borrowing, peer discovery or connected accounts | Explicitly excluded by the user’s later instruction. Do not implement or defer as an expected next feature. |
| AI outfit reranking or conversational stylist | Not selected for the first release. Evaluate only after a later request and evidence that it improves on deterministic matching using the AI-tagged catalog. |
| Generative try-on / image generation | Significant cost and additional sensitive imagery; no need for the core use case. |
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
| Phase 3 | Outfits, calendar, wear records and statistics |
| Phase 4 | Rule engine and feedback |
| Phase 5 | Optional weather and full account-isolation verification |
| Phase 6 | Export, restore, account deletion and backup scripts |
| Phase 7 | Accessibility, device performance, security and recovery acceptance; MVP release |
| Phase 8 | Optional trips/packing, only if requested after MVP |

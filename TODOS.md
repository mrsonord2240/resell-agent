# TODOS

## Multi-market listing

### Poshmark assisted fill
- **What:** A Poshmark sell-form script that uses the same assisted-fill contract as Depop: filled tab, Sam clicks Post, state table, halt rules.
- **Why:** It's the third market Sam wants. It was deferred in the CEO review (D1, 2026-11-26) because Poshmark bans automation and Sam doesn't sell there yet.
- **Pros:** It reaches Poshmark's clothing buyers, and it reuses the runner and state contract that Depop proves.
- **Cons:** Ban risk is accepted, not removed, and the halt rules must be wired. It's a second fragile form script.
- **Context:** See `docs/designs/multi-market-listing.md`, the "Assisted-fill contract" and "Poshmark halt rules" sections. Start from the Depop script once it's live. When delist sync arrives, mark sold items not-for-sale rather than deleting them.
- **Effort:** human M / CC S
- **Priority:** P2
- **Depends on:** the Depop assisted fill shipping and one real Depop session going cleanly.

### GUI batch view
- **What:** A GUI screen that lists a batch folder's items with each market's state, and lets Sam approve held items, mark unknown rows, and start a Depop session.
- **Why:** The first cut's batch is CLI-only. This was deferred in the CEO review (D2, 2026-11-26).
- **Pros:** Snap-a-pile works from the desktop app without a terminal.
- **Cons:** The GUI keeps its own draft store (with a TTL). It needs to open the CLI's `batch/<item>/draft.json` files directly, or the two stores have to be unified.
- **Context:** The GUI store lives under its data dir with a 24-hour TTL (`src/gui.ts`, `GUI_DRAFT_TTL_MS`). CLI drafts are DraftFiles (`src/draft-file.ts`). The outside voice (O7) warned against keeping two records that disagree.
- **Effort:** human L / CC M
- **Priority:** P3
- **Depends on:** `post-batch`, `status --batch` and `mark` shipping.

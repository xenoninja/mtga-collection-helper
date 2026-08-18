# MTGA Collection Helper

Tampermonkey userscript that compares a Moxfield deck with a processed MTG Arena collection. It reports missing copies, the wildcard requirement by craft rarity, and unmatched names — without sending the collection anywhere.

It runs only on Moxfield deck pages (`https://moxfield.com/decks/*` and `https://www.moxfield.com/decks/*`).

## Install

1. Install [Tampermonkey](https://www.tampermonkey.net/) in Chrome.
2. Open Tampermonkey → **Create a new script**.
3. Replace the template with the contents of [`mtga-collection-helper.user.js`](mtga-collection-helper.user.js) and save.
4. Open any Moxfield deck. The helper mounts next to the deck list.

The collection snapshot lives in Tampermonkey storage (`mtga-collection-helper.collection-snapshot`). Reinstalling the script or using another browser profile starts empty.

## Prepare a collection CSV

Upload a **processed** collection, not Arena's raw export. Required header:

```text
Id,Name,Set,Color,Rarity,Count
```

Rules the userscript enforces:

- `Rarity` is one of `Basic`, `Common`, `Uncommon`, `Rare`, `Mythic`.
- `Count` is an integer from 0 through 4 (ownership already merged across printings).
- Card names must be unique after normalization (trim, collapse whitespace, case-fold, Unicode punctuation, split-card separators).
- Quoted names with commas are valid (`"Avacyn, Angel of Hope"`).
- The first invalid row rejects the whole file and leaves the previous snapshot unchanged.

`Rarity` is used as craft rarity. Preprocessing must pick the lowest-rarity interchangeable Arena printing for each name.

This working tree keeps local collection files under `collection/` (gitignored). Save Untapped.gg's **Export collection** CSV as `collection/collection_raw.csv`. Arena's official collection export is a different schema and is not valid input to the merge script or the userscript.

| File | Role |
| --- | --- |
| `collection/collection_raw.csv` | Untapped.gg **Export collection** dump (`Id,Name,Set,Color,Rarity,Count,PrintCount`) |
| `collection/collection.csv` | One row per name — upload this |
| `collection/merge_collection.py` | Merges same-name printings, keeping the preferred rarity |

From the repo root:

```bash
python3 collection/merge_collection.py collection/collection_raw.csv collection/collection.csv
```

Pass both paths. Bare invocation looks for `collection/collection_raw.csv` relative to the script file and will miss the files in this tree.

Replacing the on-disk CSV does not update Tampermonkey storage. Upload again after regenerating.

## Check a deck

1. Open the Moxfield deck.
2. **Upload collection CSV** → choose `collection/collection.csv` (or another valid processed file).
3. Confirm the helper shows filename, unique-name count, and upload timestamp. **Check** stays disabled until a valid snapshot exists.
4. Click **Check**. The helper switches Moxfield to Text view if needed, extracts the deck, then restores the previous view.

A successful check shows:

- Total missing copies and distinct missing cards
- Wildcard counts for Common / Uncommon / Rare / Mythic
- Expandable missing-card rows: name, required, owned, missing, craft rarity
- Expandable unmatched rows: name, required, `Unknown`, `No collection match`

If the collection covers the imported deck: `Collection covers this deck. No missing copies.`

While a check is running the button reads **Checking…** and ignores extra clicks. Navigating to another deck clears the result and any error; the snapshot stays. Check again on the new deck.

### What is counted

Included: mainboard type groups, sideboard, commander, partner, companion.

Excluded: considering, maybeboard, tokens, attractions, stickers, contraptions, planes, schemes, and other non-imported groups.

Quantities are aggregated globally by normalized name, then:

```text
playset requirement = min(deck quantity, 4)
missing copies      = max(playset requirement − owned count, 0)
```

Basic cards are free: Plains, Island, Swamp, Mountain, Forest, Wastes, Snow-Covered versions of the five colored basics, and any uploaded row with rarity `Basic`. They never appear in missing or unmatched results.

Unmatched non-Basic names are listed separately and do not affect missing-copy or wildcard totals. Totals are crafting cost only — they do not subtract wildcard inventory.

Extraction is fail-closed. A missing heading, unparseable quantity, duplicate visible row, count mismatch, ambiguous deck list, render timeout, or failed view restoration clears the previous result and shows an error instead of partial totals.

## Privacy

CSV parsing, Tampermonkey storage, and comparison stay in the browser. The helper does not call Moxfield's private deck API, Scryfall, or any other card service.

## Develop

```bash
npm install
npx playwright install chromium
npm test
npm run typecheck
```

`npm test` runs Playwright against a Moxfield-shaped DOM fixture with in-memory Tampermonkey storage. It covers upload, persistence, Text-view extraction, ownership, navigation, and fail-closed errors. It does not hit live Moxfield.

After markup changes, smoke-test on a live public deck: start from a non-Text view, **Check**, confirm the view restores, and reconcile one result against the deck and CSV.

## Layout

```text
mtga-collection-helper.user.js   installable userscript
tests/                           Playwright behavioral specs
collection/                      local CSV + merge script (not tracked)
CONTEXT.md                       domain glossary
.scratch/mtga-collection-helper/ product spec and tickets
```

## Out of scope

No Chrome extension, no other userscript managers, no Arena import/clipboard, no automatic check on load or deck edit, no per-section totals, no row badges on Moxfield cards, no prices or legality, no wildcard-balance tracking, and no silent recovery after a Moxfield DOM change.

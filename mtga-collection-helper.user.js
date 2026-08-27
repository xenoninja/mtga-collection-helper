// ==UserScript==
// @name         MTGA Collection Helper
// @namespace    https://github.com/xenoninja/mtga-collection-helper
// @version      0.2.0
// @description  Compare a Moxfield deck with a processed MTGA collection.
// @author       xenoninja
// @homepageURL  https://github.com/xenoninja/mtga-collection-helper
// @downloadURL  https://raw.githubusercontent.com/xenoninja/mtga-collection-helper/master/mtga-collection-helper.user.js
// @updateURL    https://raw.githubusercontent.com/xenoninja/mtga-collection-helper/master/mtga-collection-helper.user.js
// @match        https://moxfield.com/decks/*
// @match        https://www.moxfield.com/decks/*
// @grant        GM.getValue
// @grant        GM.setValue
// @run-at       document-idle
// @noframes
// ==/UserScript==

(() => {
  "use strict";

  const STORAGE_KEY = "mtga-collection-helper.collection-snapshot";
  const SNAPSHOT_VERSION = 2;
  const EXPECTED_COLUMNS = ["Id", "Name", "Set", "Color", "Rarity", "Count"];
  /** @typedef {"Basic" | "Common" | "Uncommon" | "Rare" | "Mythic"} CraftRarity */
  const ALLOWED_RARITIES = new Set([
    "Basic",
    "Common",
    "Uncommon",
    "Rare",
    "Mythic",
  ]);
  /** @type {Record<CraftRarity, number>} */
  const CRAFT_RARITY_ORDER = {
    Mythic: 0,
    Rare: 1,
    Uncommon: 2,
    Common: 3,
    Basic: 4,
  };
  const FREE_BASIC_NAMES = new Set([
    "plains",
    "island",
    "swamp",
    "mountain",
    "forest",
    "wastes",
    "snow-covered plains",
    "snow-covered island",
    "snow-covered swamp",
    "snow-covered mountain",
    "snow-covered forest",
  ]);
  const FREE_BASIC_SLUG_KEYS = new Set(
    Array.from(FREE_BASIC_NAMES, (basicName) => slugKey(basicName)),
  );
  const INCLUDED_DECK_GROUPS = new Set([
    "artifact",
    "artifacts",
    "battle",
    "battles",
    "commander",
    "commanders",
    "companion",
    "companions",
    "creature",
    "creatures",
    "enchantment",
    "enchantments",
    "instant",
    "instants",
    "land",
    "lands",
    "mainboard",
    "partner",
    "partners",
    "planeswalker",
    "planeswalkers",
    "sideboard",
    "sorceries",
    "sorcery",
  ]);
  const tampermonkey = /** @type {{
    getValue: (key: string, fallback: unknown) => Promise<unknown> | unknown,
    setValue: (key: string, value: unknown) => Promise<void> | void
  }} */ (
    // @ts-expect-error GM is injected as a Tampermonkey userscript-scope binding.
    GM
  );

  /** @typedef {{collectionName: string, count: number, craftRarity: CraftRarity}} CollectionEntry */
  /** @typedef {{filename: string, uniqueNameCount: number, uploadedAt: string}} SnapshotMetadata */
  /** @typedef {{version: 2, cards: Record<string, CollectionEntry>, metadata: SnapshotMetadata}} CollectionSnapshot */
  /** @typedef {{printedName: string, slugKeys: string[], quantity: number}} DeckRequirementEntry */
  /** @typedef {{collectionName: string, printedNames: string[], required: number, owned: number, missing: number, craftRarity: CraftRarity}} MissingCard */
  /** @typedef {{printedName: string, required: number, craftRarity: "Unknown", reason: "No collection match"}} UnmatchedCard */
  /** @typedef {{collectionCard: CollectionEntry, printedNames: string[], quantity: number}} MatchedIdentity */
  /** @typedef {{totalMissing: number, missingCards: MissingCard[], unmatchedCards: UnmatchedCard[], wildcards: Record<Exclude<CraftRarity, "Basic">, number>}} CheckResult */

  if (document.querySelector("#mtga-collection-helper")) return;

  let activeDeckPath = location.pathname;
  let deckRevision = 0;

  const surface = document.createElement("section");
  surface.id = "mtga-collection-helper";
  surface.setAttribute("role", "region");
  surface.setAttribute("aria-labelledby", "mtga-collection-helper-title");
  surface.style.cssText = [
    "border:1px solid #d1d5db",
    "border-radius:6px",
    "padding:12px",
    "margin:12px 0",
    "background:#fff",
    "color:#111827",
    "font:14px/1.4 system-ui,sans-serif",
  ].join(";");

  const title = document.createElement("h2");
  title.id = "mtga-collection-helper-title";
  title.textContent = "MTGA Collection Helper";
  title.style.cssText = "font-size:16px;margin:0 0 10px";

  const controls = document.createElement("div");
  controls.style.cssText = "display:flex;align-items:center;gap:8px;flex-wrap:wrap";

  const uploadLabel = document.createElement("label");
  uploadLabel.textContent = "Upload collection CSV";
  uploadLabel.style.cssText = [
    "display:inline-block",
    "padding:6px 10px",
    "border:1px solid #9ca3af",
    "border-radius:4px",
    "cursor:pointer",
  ].join(";");

  const uploadInput = document.createElement("input");
  uploadInput.type = "file";
  uploadInput.disabled = true;
  uploadInput.accept = ".csv,text/csv";
  uploadInput.setAttribute("aria-label", "Upload collection CSV");
  uploadInput.style.cssText = [
    "position:absolute",
    "width:1px",
    "height:1px",
    "overflow:hidden",
    "clip:rect(0 0 0 0)",
    "white-space:nowrap",
  ].join(";");
  uploadLabel.append(uploadInput);

  const checkButton = document.createElement("button");
  checkButton.type = "button";
  checkButton.textContent = "Check";
  checkButton.disabled = true;
  checkButton.style.cssText = "padding:6px 10px";

  const metadataElement = document.createElement("p");
  metadataElement.style.cssText = "margin:10px 0 0";
  metadataElement.textContent = "No collection snapshot uploaded.";

  const error = document.createElement("p");
  error.setAttribute("role", "alert");
  error.hidden = true;
  error.style.cssText = "color:#b91c1c;margin:10px 0 0";

  const resultElement = document.createElement("section");
  resultElement.setAttribute("role", "region");
  resultElement.setAttribute("aria-label", "Deck check result");
  resultElement.hidden = true;

  controls.append(uploadLabel, checkButton);
  surface.append(title, controls, metadataElement, error, resultElement);
  syncSurface();

  const restoration = restoreSnapshot();
  let pendingWork = restoration;
  void restoration.finally(() => {
    if (pendingWork === restoration) uploadInput.disabled = false;
  });
  /** @type {CollectionSnapshot | null} */
  let activeSnapshot = null;
  let checkInProgress = false;
  uploadInput.addEventListener("change", () => {
    const file = uploadInput.files?.[0];
    if (!file) return;

    uploadInput.value = "";
    uploadInput.disabled = true;
    const upload = pendingWork.then(() => handleUpload(file));
    pendingWork = upload;
    void upload.finally(() => {
      if (pendingWork === upload) uploadInput.disabled = false;
    });
  });
  checkButton.addEventListener("click", () => {
    if (!activeSnapshot || checkInProgress) return;
    void handleCheck(activeSnapshot);
  });

  const pushState = history.pushState;
  history.pushState = function (data, unused, url) {
    pushState.call(this, data, unused, url);
    handleDeckNavigation();
  };
  const replaceState = history.replaceState;
  history.replaceState = function (data, unused, url) {
    replaceState.call(this, data, unused, url);
    handleDeckNavigation();
  };
  window.addEventListener("popstate", handleDeckNavigation);
  const deckObserver = new MutationObserver(() => {
    handleDeckNavigation();
    syncSurface();
  });
  deckObserver.observe(document.body, { childList: true, subtree: true });

  function handleDeckNavigation() {
    const nextDeckPath = location.pathname;
    if (nextDeckPath === activeDeckPath) return;
    activeDeckPath = nextDeckPath;
    deckRevision += 1;
    hideError();
    clearResult();
    syncSurface();
  }

  function syncSurface() {
    if (!activeDeckPath.startsWith("/decks/")) {
      surface.remove();
      return;
    }
    mountSurface();
  }

  function mountSurface() {
    const currentDeckList = findDeckListMount();
    if (!currentDeckList?.parentElement) return;
    if (
      surface.parentElement !== currentDeckList.parentElement ||
      surface.nextSibling !== currentDeckList
    ) {
      currentDeckList.parentElement.insertBefore(surface, currentDeckList);
    }
  }

  function findDeckListMount() {
    const visibleDeckLists = findVisibleDeckLists();
    if (visibleDeckLists.length === 1) return visibleDeckLists[0];
    return (
      document.querySelector('[data-testid="deck-list"]') ??
      document.querySelector('[aria-label="Deck list"]') ??
      document.querySelector("main")
    );
  }

  /** @returns {HTMLElement[]} */
  function findVisibleDeckLists() {
    return Array.from(
      new Set(
        Array.from(document.querySelectorAll("h1,h2,h3"))
          .filter((heading) => heading.textContent?.trim() === "Deck List")
          .map((heading) => heading.closest("section"))
          .filter(
            /** @returns {section is HTMLElement} */
            (section) => section instanceof HTMLElement && isVisible(section),
          ),
      ),
    );
  }

  async function restoreSnapshot() {
    try {
      const stored = await tampermonkey.getValue(STORAGE_KEY, null);
      if (isSnapshot(stored)) {
        setActiveSnapshot(stored);
        return;
      }
      if (isOutdatedSnapshot(stored)) {
        showError(
          "The stored collection snapshot uses an older format. Upload the collection CSV again.",
        );
      } else if (stored) {
        showError(
          "The stored collection snapshot could not be read. Upload the collection CSV again.",
        );
      }
    } catch (cause) {
      showError(`Could not restore the collection snapshot: ${errorMessage(cause)}`);
    }
  }

  /** @param {File} file */
  async function handleUpload(file) {
    hideError();
    try {
      const csv = await file.text();
      const snapshot = createSnapshot(csv, file.name, new Date().toISOString());
      await tampermonkey.setValue(STORAGE_KEY, snapshot);
      setActiveSnapshot(snapshot);
    } catch (cause) {
      showError(errorMessage(cause));
    }
  }

  /** @param {CollectionSnapshot} snapshot */
  async function handleCheck(snapshot) {
    const checkRevision = deckRevision;
    checkInProgress = true;
    checkButton.disabled = true;
    checkButton.textContent = "Checking…";
    uploadInput.disabled = true;
    hideError();
    clearResult();

    try {
      const activeDeckList = findActiveDeckList();
      const viewControl = activeDeckList.querySelector('select[name="viewMode"]');
      if (!(viewControl instanceof HTMLSelectElement)) {
        throw new Error("Could not find Moxfield's View control.");
      }
      const groupControl = activeDeckList.querySelector('select[name="groupBy"]');
      if (!(groupControl instanceof HTMLSelectElement)) {
        throw new Error("Could not find Moxfield's Group control.");
      }

      const originalView = viewControl.value;
      const originalGrouping = groupControl.value;
      /** @type {Map<string, DeckRequirementEntry> | null} */
      let requirement = null;
      /** @type {unknown} */
      let checkFailure = null;
      try {
        if (originalGrouping !== "type") selectControlValue(groupControl, "type");
        if (originalView !== "table") selectControlValue(viewControl, "table");
        requirement = await waitForStableDeckRequirement(viewControl, groupControl);
      } catch (cause) {
        checkFailure = cause;
      } finally {
        const changedGrouping = originalGrouping !== "type";
        const changedView = originalView !== "table";
        if (changedGrouping || changedView) {
          try {
            if (changedGrouping) selectControlValue(groupControl, originalGrouping);
            if (changedView) selectControlValue(viewControl, originalView);
            await waitForStableRenderedView(
              viewControl,
              groupControl,
              activeDeckList,
              originalView,
              originalGrouping,
            );
          } catch (cause) {
            checkFailure = new Error(
              `Could not restore the Moxfield view: ${errorMessage(cause)}`,
            );
          }
        }
      }

      if (checkRevision !== deckRevision) return;

      if (checkFailure) throw checkFailure;
      if (!requirement) throw new Error("Could not read the rendered deck list.");
      renderResult(compareRequirement(requirement, snapshot));
    } catch (cause) {
      if (checkRevision === deckRevision) {
        showError(`Could not check this deck: ${errorMessage(cause)}`);
      }
    } finally {
      checkInProgress = false;
      checkButton.textContent = "Check";
      checkButton.disabled = activeSnapshot === null;
      uploadInput.disabled = false;
    }
  }

  /** @returns {HTMLElement} */
  function findActiveDeckList() {
    const candidates = findVisibleDeckLists();
    if (candidates.length !== 1) {
      throw new Error(
        candidates.length === 0
          ? "Could not find the active Moxfield deck list."
          : "Found more than one active Moxfield deck list.",
      );
    }
    return candidates[0];
  }

  /** @param {HTMLSelectElement} control @param {string} value */
  function selectControlValue(control, value) {
    if (!Array.from(control.options).some((option) => option.value === value)) {
      throw new Error(`Moxfield option "${value}" is unavailable.`);
    }
    control.value = value;
    control.dispatchEvent(new Event("input", { bubbles: true }));
    control.dispatchEvent(new Event("change", { bubbles: true }));
  }

  /**
   * @param {HTMLSelectElement} viewControl
   * @param {HTMLSelectElement} groupControl
   * @returns {Promise<Map<string, DeckRequirementEntry>>}
   */
  async function waitForStableDeckRequirement(viewControl, groupControl) {
    const deadline = Date.now() + 5_000;
    let previousSignature = "";
    let stableSamples = 0;
    /** @type {unknown} */
    let lastFailure = null;

    while (Date.now() < deadline) {
      try {
        if (viewControl.value !== "table") throw new Error("Text view is not selected.");
        if (groupControl.value !== "type") {
          throw new Error("Type grouping is not selected.");
        }
        const requirement = readDeckRequirement(findActiveDeckList());
        const signature = JSON.stringify(Array.from(requirement.entries()));
        if (signature === previousSignature) {
          stableSamples += 1;
          if (stableSamples >= 1) return requirement;
        } else {
          previousSignature = signature;
          stableSamples = 0;
        }
        lastFailure = null;
      } catch (cause) {
        previousSignature = "";
        stableSamples = 0;
        lastFailure = cause;
      }
      await delay(50);
    }

    throw new Error(
      `Moxfield Text view did not stabilize: ${errorMessage(lastFailure ?? "timed out")}`,
    );
  }

  /**
   * @param {HTMLSelectElement} viewControl
   * @param {HTMLSelectElement} groupControl
   * @param {HTMLElement} activeDeckList
   * @param {string} expectedView
   * @param {string} expectedGrouping
   */
  async function waitForStableRenderedView(
    viewControl,
    groupControl,
    activeDeckList,
    expectedView,
    expectedGrouping,
  ) {
    const deadline = Date.now() + 5_000;
    let previousSignature = "";
    let stableSamples = 0;
    while (Date.now() < deadline) {
      if (viewControl.value === expectedView && groupControl.value === expectedGrouping) {
        const signature = activeDeckList.textContent ?? "";
        if (signature === previousSignature) {
          stableSamples += 1;
          if (stableSamples >= 1) return;
        } else {
          previousSignature = signature;
          stableSamples = 0;
        }
      }
      await delay(50);
    }
    throw new Error(`Moxfield view "${expectedView}" did not stabilize.`);
  }

  /**
   * @param {HTMLElement} activeDeckList
   * @returns {Map<string, DeckRequirementEntry>}
   */
  function readDeckRequirement(activeDeckList) {
    const lists = Array.from(activeDeckList.querySelectorAll("article ul")).filter(isVisible);
    if (lists.length === 0) throw new Error("Text view has no visible deck groups.");

    /** @type {Map<string, DeckRequirementEntry>} */
    const requirement = new Map();
    /** @type {Map<string, Set<string>>} */
    const paintedRowsByGroup = new Map();
    for (const list of lists) {
      const items = Array.from(list.children).filter(isVisible);
      const heading = items.shift();
      const headingLabel = heading?.querySelector("a, button") ?? heading;
      const headingMatch = headingLabel?.textContent
        ?.trim()
        .match(/^(.+?)\s*\((\d+)\)\s*$/u);
      if (!heading || !headingMatch) {
        throw new Error("A visible deck group has no displayed heading and card count.");
      }

      const groupName = collapseWhitespace(headingMatch[1]).toLowerCase();
      if (!INCLUDED_DECK_GROUPS.has(groupName)) continue;
      const paintedRows = paintedRowsByGroup.get(groupName) ?? new Set();
      paintedRowsByGroup.set(groupName, paintedRows);

      const displayedCount = Number(headingMatch[2]);
      const groupHeading = headingMatch[1].trim();
      let extractedCount = 0;
      for (const row of items) {
        const cardLink = row.querySelector('a[href^="/cards/"]');
        const quantityText = row.firstElementChild?.textContent?.trim() ?? "";
        if (!(cardLink instanceof HTMLAnchorElement) || !cardLink.textContent?.trim()) {
          throw new Error("A visible deck row has no card name.");
        }
        if (!/^\d+$/u.test(quantityText) || Number(quantityText) < 1) {
          throw new Error(`Could not read the quantity for "${cardLink.textContent.trim()}".`);
        }

        const paintKey = row.getAttribute("data-hash")?.trim();
        if (!paintKey) {
          throw new Error(`Could not identify a painted row in the "${groupHeading}" group.`);
        }
        if (paintedRows.has(paintKey)) {
          throw new Error(`The "${groupHeading}" group contains a duplicate painted row.`);
        }
        paintedRows.add(paintKey);

        const quantity = Number(quantityText);
        const printedName = collapseWhitespace(cardLink.textContent);
        const normalizedName = normalizeName(printedName);
        const existing = requirement.get(normalizedName);

        if (existing) existing.quantity += quantity;
        else {
          requirement.set(normalizedName, {
            printedName,
            slugKeys: linkSlugKeys(cardLink.getAttribute("href")),
            quantity,
          });
        }
        extractedCount += quantity;
      }
      if (extractedCount !== displayedCount) {
        throw new Error(
          `Deck group count mismatch: Moxfield shows ${displayedCount}, but ${extractedCount} copies were read.`,
        );
      }
    }
    return requirement;
  }

  /**
   * @param {Map<string, DeckRequirementEntry>} requirement
   * @param {CollectionSnapshot} snapshot
   * @returns {CheckResult}
   */
  function compareRequirement(requirement, snapshot) {
    /** @type {CheckResult["wildcards"]} */
    const wildcards = { Common: 0, Uncommon: 0, Rare: 0, Mythic: 0 };
    /** @type {MissingCard[]} */
    const missingCards = [];
    /** @type {UnmatchedCard[]} */
    const unmatchedCards = [];
    let totalMissing = 0;

    /** @type {Map<string, MatchedIdentity>} */
    const matched = new Map();
    /** @type {DeckRequirementEntry[]} */
    const unresolved = [];

    for (const [normalizedName, deckCard] of requirement) {
      // A flavor-named basic prints a name the free list does not carry, so the
      // card link has to be consulted before the row can be called non-basic.
      if (isFreeBasic(normalizedName, deckCard.slugKeys)) continue;
      const collectionCard = snapshot.cards[normalizedName];
      if (!collectionCard) {
        unresolved.push(deckCard);
        continue;
      }
      addMatch(matched, normalizedName, collectionCard, deckCard);
    }

    // A flavor-name printing prints a name the collection never uses, so it can
    // only arrive here. Its card link still names the card, so resolve on that.
    /** @type {Map<string, string>} */
    const slugIndex = unresolved.length > 0 ? buildSlugIndex(snapshot) : new Map();
    for (const deckCard of unresolved) {
      const identity = resolveIdentity(deckCard, slugIndex);
      const collectionCard = identity ? snapshot.cards[identity] : undefined;
      if (!identity || !collectionCard) {
        unmatchedCards.push({
          printedName: deckCard.printedName,
          required: deckCard.quantity,
          craftRarity: "Unknown",
          reason: "No collection match",
        });
        continue;
      }
      addMatch(matched, identity, collectionCard, deckCard);
    }

    for (const [identity, match] of matched) {
      const { collectionCard } = match;
      if (collectionCard.craftRarity === "Basic") continue;
      const playsetRequirement = Math.min(match.quantity, 4);
      const missing = Math.max(playsetRequirement - collectionCard.count, 0);
      if (missing === 0) continue;
      missingCards.push({
        collectionName: collectionCard.collectionName,
        // A row that printed the collection's own name adds nothing to report,
        // so only the printings that spell the card differently are listed.
        printedNames: match.printedNames.filter(
          (printedName) => normalizeName(printedName) !== identity,
        ),
        required: playsetRequirement,
        owned: collectionCard.count,
        missing,
        craftRarity: collectionCard.craftRarity,
      });
      totalMissing += missing;
      wildcards[collectionCard.craftRarity] += missing;
    }
    missingCards.sort((left, right) => {
      const byRarity =
        CRAFT_RARITY_ORDER[left.craftRarity] - CRAFT_RARITY_ORDER[right.craftRarity];
      if (byRarity !== 0) return byRarity;
      return left.collectionName.localeCompare(right.collectionName);
    });
    unmatchedCards.sort((left, right) =>
      left.printedName.localeCompare(right.printedName),
    );
    return { totalMissing, missingCards, unmatchedCards, wildcards };
  }

  /** @param {CheckResult} result */
  function renderResult(result) {
    resultElement.replaceChildren();
    const heading = document.createElement("h3");
    heading.textContent = "Deck check result";
    heading.style.cssText = "font-size:15px;margin:12px 0 6px";

    const summary = document.createElement("p");
    summary.style.cssText = "margin:0 0 8px";
    summary.textContent = `${result.totalMissing} missing copies across ${result.missingCards.length} distinct missing cards.`;

    const wildcardList = document.createElement("dl");
    wildcardList.style.cssText =
      "display:grid;grid-template-columns:auto auto;gap:2px 12px;width:max-content;margin:0";
    for (const rarity of /** @type {const} */ (["Common", "Uncommon", "Rare", "Mythic"])) {
      const row = document.createElement("div");
      row.style.display = "contents";
      const term = document.createElement("dt");
      term.textContent = rarity;
      const count = document.createElement("dd");
      count.textContent = String(result.wildcards[rarity]);
      count.style.margin = "0";
      row.append(term, count);
      wildcardList.append(row);
    }
    resultElement.append(heading, summary, wildcardList);

    if (result.missingCards.length === 0 && result.unmatchedCards.length === 0) {
      const emptySuccess = document.createElement("p");
      emptySuccess.textContent = "Collection covers this deck. No missing copies.";
      emptySuccess.style.cssText = "margin:8px 0 0";
      resultElement.append(emptySuccess);
    }
    if (result.missingCards.length > 0) {
      appendCardDetails(
        `Missing card details (${result.missingCards.length})`,
        ["Card name", "Required", "Owned", "Missing", "Craft rarity"],
        result.missingCards,
        (card) => [
          formatMissingName(card),
          card.required,
          card.owned,
          card.missing,
          card.craftRarity,
        ],
      );
    }
    if (result.unmatchedCards.length > 0) {
      appendCardDetails(
        `Unmatched card details (${result.unmatchedCards.length})`,
        ["Card name", "Required", "Craft rarity", "Reason"],
        result.unmatchedCards,
        (card) => [card.printedName, card.required, card.craftRarity, card.reason],
      );
    }
    resultElement.hidden = false;
  }

  /**
   * Leads with the collection name, because that is what the player searches for
   * when crafting, and notes any printed name that differs so the row can still
   * be found in the deck list.
   *
   * @param {MissingCard} card
   */
  function formatMissingName(card) {
    if (card.printedNames.length === 0) return card.collectionName;
    const printed = card.printedNames.map((printedName) => `"${printedName}"`).join(", ");
    return `${card.collectionName} (as ${printed})`;
  }

  /**
   * @template T
   * @param {string} summaryText
   * @param {string[]} labels
   * @param {T[]} cards
   * @param {(card: T) => (string | number)[]} valuesForCard
   */
  function appendCardDetails(summaryText, labels, cards, valuesForCard) {
    const details = document.createElement("details");
    details.style.cssText = "margin-top:8px";
    const detailsSummary = document.createElement("summary");
    detailsSummary.textContent = summaryText;
    const table = document.createElement("table");
    table.style.cssText = "border-collapse:collapse;margin-top:6px;text-align:left";
    const head = document.createElement("thead");
    const headingRow = document.createElement("tr");
    for (const label of labels) {
      const cell = document.createElement("th");
      cell.scope = "col";
      cell.textContent = label;
      cell.style.paddingRight = "12px";
      headingRow.append(cell);
    }
    head.append(headingRow);
    const body = document.createElement("tbody");
    for (const card of cards) {
      const row = document.createElement("tr");
      for (const value of valuesForCard(card)) {
        const cell = document.createElement("td");
        cell.textContent = String(value);
        cell.style.paddingRight = "12px";
        row.append(cell);
      }
      body.append(row);
    }
    table.append(head, body);
    details.append(detailsSummary, table);
    resultElement.append(details);
  }

  function clearResult() {
    resultElement.replaceChildren();
    resultElement.hidden = true;
  }

  /** @param {Element} element */
  function isVisible(element) {
    return (
      element instanceof HTMLElement &&
      !element.hidden &&
      element.getAttribute("aria-hidden") !== "true" &&
      getComputedStyle(element).display !== "none" &&
      element.getClientRects().length > 0
    );
  }

  /** @param {number} milliseconds */
  function delay(milliseconds) {
    return new Promise((resolve) => setTimeout(resolve, milliseconds));
  }

  /**
   * @param {string} csv
   * @param {string} filename
   * @param {string} uploadedAt
   * @returns {CollectionSnapshot}
   */
  function createSnapshot(csv, filename, uploadedAt) {
    const rows = parseCsv(csv.replace(/^\uFEFF/, ""));
    const header = rows.shift();
    if (!header) {
      throw new Error(`CSV header: expected ${EXPECTED_COLUMNS.join(",")}.`);
    }
    const missingColumn = EXPECTED_COLUMNS.find((column) => !header.includes(column));
    if (missingColumn) {
      throw new Error(`CSV header: missing column "${missingColumn}".`);
    }
    const unexpectedColumn = header.find((column) => !EXPECTED_COLUMNS.includes(column));
    if (unexpectedColumn) {
      throw new Error(`CSV header: unexpected column "${unexpectedColumn}".`);
    }
    if (header.join("\u0000") !== EXPECTED_COLUMNS.join("\u0000")) {
      throw new Error(`CSV header columns must be ${EXPECTED_COLUMNS.join(",")} in that order.`);
    }

    /** @type {Record<string, CollectionEntry>} */
    const cards = Object.create(null);
    for (let index = 0; index < rows.length; index += 1) {
      const row = rows[index];
      const csvRow = index + 2;
      if (row.length !== EXPECTED_COLUMNS.length) {
        throw new Error(
          `CSV row ${csvRow}: expected ${EXPECTED_COLUMNS.length} columns but found ${row.length}.`,
        );
      }
      const normalizedName = normalizeName(row[1]);
      if (!normalizedName) throw new Error(`CSV row ${csvRow}: Name is empty.`);
      if (Object.hasOwn(cards, normalizedName)) {
        throw new Error(`CSV row ${csvRow}: duplicate normalized Name "${row[1]}".`);
      }
      const craftRarity = row[4];
      if (!ALLOWED_RARITIES.has(craftRarity)) {
        throw new Error(`CSV row ${csvRow}: unsupported Rarity "${craftRarity}".`);
      }
      const countText = row[5];
      const count = Number(countText);
      if (!/^\d+$/u.test(countText) || !Number.isInteger(count) || count > 4) {
        throw new Error(`CSV row ${csvRow}: Count must be an integer from 0 through 4.`);
      }
      cards[normalizedName] = {
        collectionName: collapseWhitespace(row[1]),
        count,
        craftRarity: /** @type {CraftRarity} */ (craftRarity),
      };
    }

    return {
      version: SNAPSHOT_VERSION,
      cards,
      metadata: {
        filename,
        uniqueNameCount: Object.keys(cards).length,
        uploadedAt,
      },
    };
  }

  /** @param {string} value */
  function collapseWhitespace(value) {
    return value.trim().replace(/\s+/gu, " ");
  }

  /** @param {string} value */
  function normalizeName(value) {
    return value
      .normalize("NFKC")
      .replace(/[‘’‛ʼ]/gu, "'")
      .replace(/[‐‑‒–—―]/gu, "-")
      .replace(/\s*(?:[/⁄∕]\s*){1,2}/gu, " // ")
      .trim()
      .replace(/\s+/gu, " ")
      .toLocaleLowerCase("en-US");
  }

  /**
   * Reduces a card name or a card-link slug to the form both share: letters and
   * digits only. Moxfield's own punctuation policy inside a slug is unknown and
   * need not be guessed at, because this form discards all of it.
   *
   * @param {string} value
   */
  function slugKey(value) {
    return value
      .normalize("NFD")
      .replace(/\p{Mn}/gu, "")
      .toLocaleLowerCase("en-US")
      .replace(/[^a-z0-9]+/gu, "");
  }

  /**
   * Reads the card identity out of a Moxfield card link. The href is shaped
   * `/cards/{id}-{slug}`, and the slug names the card even when the row's
   * printed name does not.
   *
   * Where the id itself contains a hyphen the boundary is not observable, so
   * every split point is offered as a candidate. A candidate only counts when it
   * equals a whole collection name, and `resolveIdentity` discards a set that
   * names two different cards, so guessing wide stays safe.
   *
   * Absence of a slug is not a DOM fault the way a missing name or quantity is —
   * it withholds evidence rather than contradicting it — so this returns an empty
   * candidate list and the row simply stays unmatched, instead of throwing.
   *
   * @param {string | null} href
   * @returns {string[]} candidate slug keys, nearest-first
   */
  function linkSlugKeys(href) {
    if (!href) return [];
    const segment = href.split(/[?#]/u)[0].split("/").filter(Boolean).pop() ?? "";
    /** @type {string[]} */
    const keys = [];
    for (
      let index = segment.indexOf("-");
      index >= 0;
      index = segment.indexOf("-", index + 1)
    ) {
      const key = slugKey(segment.slice(index + 1));
      if (key && !keys.includes(key)) keys.push(key);
    }
    return keys;
  }

  /**
   * @param {string} normalizedName
   * @param {string[]} slugKeys
   */
  function isFreeBasic(normalizedName, slugKeys) {
    if (FREE_BASIC_NAMES.has(normalizedName)) return true;
    return slugKeys.some((key) => FREE_BASIC_SLUG_KEYS.has(key));
  }

  /**
   * Picks the one card identity a row's candidate slug keys agree on. Candidates
   * that name nothing are ignored; candidates that name two different cards
   * resolve nothing.
   *
   * @param {DeckRequirementEntry} deckCard
   * @param {Map<string, string>} slugIndex
   * @returns {string | undefined}
   */
  function resolveIdentity(deckCard, slugIndex) {
    /** @type {string | undefined} */
    let resolved;
    for (const key of deckCard.slugKeys) {
      const identity = slugIndex.get(key);
      if (!identity) continue;
      if (resolved !== undefined && resolved !== identity) return undefined;
      resolved = identity;
    }
    return resolved;
  }

  /**
   * @param {Map<string, MatchedIdentity>} matched
   * @param {string} identity
   * @param {CollectionEntry} collectionCard
   * @param {DeckRequirementEntry} deckCard
   */
  function addMatch(matched, identity, collectionCard, deckCard) {
    const existing = matched.get(identity);
    if (existing) {
      existing.quantity += deckCard.quantity;
      existing.printedNames.push(deckCard.printedName);
      return;
    }
    matched.set(identity, {
      collectionCard,
      printedNames: [deckCard.printedName],
      quantity: deckCard.quantity,
    });
  }

  /**
   * Indexes the collection by slug key. A key claimed by two collection names is
   * dropped rather than guessed at, so an ambiguous slug stays unmatched.
   *
   * @param {CollectionSnapshot} snapshot
   * @returns {Map<string, string>} slug key to normalized collection name
   */
  function buildSlugIndex(snapshot) {
    /** @type {Map<string, string>} */
    const index = new Map();
    /** @type {Set<string>} */
    const ambiguous = new Set();
    for (const normalizedName of Object.keys(snapshot.cards)) {
      const key = slugKey(normalizedName);
      if (!key || ambiguous.has(key)) continue;
      if (index.has(key)) {
        index.delete(key);
        ambiguous.add(key);
        continue;
      }
      index.set(key, normalizedName);
    }
    return index;
  }

  /**
   * @param {string} csv
   * @returns {string[][]}
   */
  function parseCsv(csv) {
    /** @type {string[][]} */
    const rows = [];
    /** @type {string[]} */
    let row = [];
    let field = "";
    let quoted = false;
    let afterQuote = false;
    let csvRow = 1;

    for (let index = 0; index < csv.length; index += 1) {
      const char = csv[index];
      if (quoted) {
        if (char === '"') {
          if (csv[index + 1] === '"') {
            field += '"';
            index += 1;
          } else {
            quoted = false;
            afterQuote = true;
          }
        } else {
          field += char;
          if (char === "\n" || (char === "\r" && csv[index + 1] !== "\n")) csvRow += 1;
        }
      } else if (afterQuote) {
        if (char === ",") {
          row.push(field);
          field = "";
          afterQuote = false;
        } else if (char === "\r" || char === "\n") {
          row.push(field);
          rows.push(row);
          row = [];
          field = "";
          afterQuote = false;
          if (char === "\r" && csv[index + 1] === "\n") index += 1;
          csvRow += 1;
        } else {
          throw new Error(
            `CSV row ${csvRow}: unexpected character after a closing quote.`,
          );
        }
      } else if (char === '"') {
        if (field.length > 0) {
          throw new Error(`CSV row ${csvRow}: quote in an unquoted field.`);
        }
        quoted = true;
      } else if (char === ",") {
        row.push(field);
        field = "";
      } else if (char === "\r" || char === "\n") {
        row.push(field);
        rows.push(row);
        row = [];
        field = "";
        if (char === "\r" && csv[index + 1] === "\n") index += 1;
        csvRow += 1;
      } else {
        field += char;
      }
    }

    if (quoted) throw new Error(`CSV row ${csvRow}: unterminated quoted field.`);
    if (field.length > 0 || row.length > 0 || afterQuote) {
      row.push(field);
      rows.push(row);
    }
    return rows;
  }

  /** @param {CollectionSnapshot} snapshot */
  function setActiveSnapshot(snapshot) {
    activeSnapshot = snapshot;
    checkButton.disabled = false;
    renderMetadata(snapshot.metadata);
  }

  /** @param {SnapshotMetadata} value */
  function renderMetadata(value) {
    metadataElement.replaceChildren();
    const countLabel = value.uniqueNameCount === 1 ? "unique card name" : "unique card names";
    metadataElement.append(
      `${value.filename} · ${value.uniqueNameCount} ${countLabel} · uploaded `,
    );
    const time = document.createElement("time");
    time.dateTime = value.uploadedAt;
    time.textContent = new Date(value.uploadedAt).toLocaleString();
    metadataElement.append(time);
  }

  /** @param {string} message */
  function showError(message) {
    error.textContent = message;
    error.hidden = false;
  }

  function hideError() {
    error.textContent = "";
    error.hidden = true;
  }

  /** @param {unknown} cause */
  function errorMessage(cause) {
    return cause instanceof Error ? cause.message : String(cause);
  }

  /** @param {unknown} value */
  function isOutdatedSnapshot(value) {
    if (!value || typeof value !== "object" || !("version" in value)) return false;
    const version = /** @type {{version: unknown}} */ (value).version;
    return Number.isInteger(version) && version !== SNAPSHOT_VERSION;
  }

  /** @param {unknown} value @returns {value is CollectionSnapshot} */
  function isSnapshot(value) {
    if (!value || typeof value !== "object") return false;
    const candidate = /** @type {Partial<CollectionSnapshot>} */ (value);
    return (
      candidate.version === SNAPSHOT_VERSION &&
      !!candidate.cards &&
      typeof candidate.cards === "object" &&
      !!candidate.metadata &&
      typeof candidate.metadata.filename === "string" &&
      Number.isInteger(candidate.metadata.uniqueNameCount) &&
      typeof candidate.metadata.uploadedAt === "string"
    );
  }
})();

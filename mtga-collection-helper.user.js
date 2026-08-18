// ==UserScript==
// @name         MTGA Collection Helper
// @namespace    https://github.com/xenoninja/mtga-collection-helper
// @version      0.1.0
// @description  Compare a Moxfield deck with a processed MTGA collection.
// @match        https://www.moxfield.com/decks/*
// @grant        GM.getValue
// @grant        GM.setValue
// @run-at       document-idle
// ==/UserScript==

(() => {
  "use strict";

  const STORAGE_KEY = "mtga-collection-helper.collection-snapshot";
  const EXPECTED_COLUMNS = ["Id", "Name", "Set", "Color", "Rarity", "Count"];
  /** @typedef {"Basic" | "Common" | "Uncommon" | "Rare" | "Mythic"} CraftRarity */
  const ALLOWED_RARITIES = new Set([
    "Basic",
    "Common",
    "Uncommon",
    "Rare",
    "Mythic",
  ]);
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
  }} */ (/** @type {any} */ (globalThis).GM);

  /** @typedef {{count: number, craftRarity: CraftRarity}} CollectionEntry */
  /** @typedef {{filename: string, uniqueNameCount: number, uploadedAt: string}} SnapshotMetadata */
  /** @typedef {{version: 1, cards: Record<string, CollectionEntry>, metadata: SnapshotMetadata}} CollectionSnapshot */
  /** @typedef {{name: string, quantity: number}} DeckRequirementEntry */
  /** @typedef {{name: string, required: number, owned: number, missing: number, craftRarity: CraftRarity}} MissingCard */
  /** @typedef {{totalMissing: number, missingCards: MissingCard[], wildcards: Record<Exclude<CraftRarity, "Basic">, number>}} CheckResult */

  if (document.querySelector("#mtga-collection-helper")) return;

  const deckList =
    document.querySelector('[data-testid="deck-list"]') ??
    document.querySelector('[aria-label="Deck list"]') ??
    document.querySelector("main");
  if (!deckList?.parentElement) return;

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
  deckList.parentElement.insertBefore(surface, deckList);

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

  async function restoreSnapshot() {
    try {
      const stored = await tampermonkey.getValue(STORAGE_KEY, null);
      if (isSnapshot(stored)) setActiveSnapshot(stored);
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

      const originalView = viewControl.value;
      /** @type {Map<string, DeckRequirementEntry> | null} */
      let requirement = null;
      /** @type {unknown} */
      let checkFailure = null;
      try {
        if (originalView !== "table") selectView(viewControl, "table");
        requirement = await waitForStableDeckRequirement(viewControl);
      } catch (cause) {
        checkFailure = cause;
      } finally {
        if (originalView !== "table") {
          try {
            selectView(viewControl, originalView);
            await waitForStableRenderedView(viewControl, activeDeckList, originalView);
          } catch (cause) {
            checkFailure = new Error(
              `Could not restore the Moxfield view: ${errorMessage(cause)}`,
            );
          }
        }
      }

      if (checkFailure) throw checkFailure;
      if (!requirement) throw new Error("Could not read the rendered deck list.");
      renderResult(compareRequirement(requirement, snapshot));
    } catch (cause) {
      showError(`Could not check this deck: ${errorMessage(cause)}`);
    } finally {
      checkInProgress = false;
      checkButton.textContent = "Check";
      checkButton.disabled = activeSnapshot === null;
      uploadInput.disabled = false;
    }
  }

  /** @returns {HTMLElement} */
  function findActiveDeckList() {
    const candidates = new Set(
      Array.from(document.querySelectorAll("h1,h2,h3"))
        .filter((heading) => heading.textContent?.trim() === "Deck List")
        .map((heading) => heading.closest("section"))
        .filter(
          /** @returns {section is HTMLElement} */
          (section) => section instanceof HTMLElement && isVisible(section),
        ),
    );
    if (candidates.size !== 1) {
      throw new Error(
        candidates.size === 0
          ? "Could not find the active Moxfield deck list."
          : "Found more than one active Moxfield deck list.",
      );
    }
    return /** @type {HTMLElement} */ (candidates.values().next().value);
  }

  /** @param {HTMLSelectElement} viewControl @param {string} value */
  function selectView(viewControl, value) {
    if (!Array.from(viewControl.options).some((option) => option.value === value)) {
      throw new Error(`Moxfield view "${value}" is unavailable.`);
    }
    viewControl.value = value;
    viewControl.dispatchEvent(new Event("input", { bubbles: true }));
    viewControl.dispatchEvent(new Event("change", { bubbles: true }));
  }

  /**
   * @param {HTMLSelectElement} viewControl
   * @returns {Promise<Map<string, DeckRequirementEntry>>}
   */
  async function waitForStableDeckRequirement(viewControl) {
    const deadline = Date.now() + 5_000;
    let previousSignature = "";
    let stableSamples = 0;
    /** @type {unknown} */
    let lastFailure = null;

    while (Date.now() < deadline) {
      try {
        if (viewControl.value !== "table") throw new Error("Text view is not selected.");
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
   * @param {HTMLElement} activeDeckList
   * @param {string} expectedView
   */
  async function waitForStableRenderedView(viewControl, activeDeckList, expectedView) {
    const deadline = Date.now() + 5_000;
    let previousSignature = "";
    let stableSamples = 0;
    while (Date.now() < deadline) {
      if (viewControl.value === expectedView) {
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
    const paintedRows = new Set();
    for (const list of lists) {
      const items = Array.from(list.children).filter(isVisible);
      const heading = items.shift();
      const headingMatch = heading?.textContent
        ?.trim()
        .match(/^(.+?)\s*\((\d+)\)\s*$/u);
      if (!heading || !headingMatch) {
        throw new Error("A visible deck group has no displayed heading and card count.");
      }

      const groupName = headingMatch[1].trim().replace(/\s+/gu, " ").toLowerCase();
      if (!INCLUDED_DECK_GROUPS.has(groupName)) continue;

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
        const name = cardLink.textContent.trim().replace(/\s+/gu, " ");
        const normalizedName = normalizeName(name);
        const existing = requirement.get(normalizedName);

        if (existing) existing.quantity += quantity;
        else requirement.set(normalizedName, { name, quantity });
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
    let totalMissing = 0;

    for (const [normalizedName, deckCard] of requirement) {
      const collectionCard = snapshot.cards[normalizedName];
      if (!collectionCard) {
        throw new Error(`No collection match for "${deckCard.name}".`);
      }
      if (collectionCard.craftRarity === "Basic") continue;
      const missing = Math.max(deckCard.quantity - collectionCard.count, 0);
      if (missing === 0) continue;
      missingCards.push({
        name: deckCard.name,
        required: deckCard.quantity,
        owned: collectionCard.count,
        missing,
        craftRarity: collectionCard.craftRarity,
      });
      totalMissing += missing;
      wildcards[collectionCard.craftRarity] += missing;
    }
    missingCards.sort((left, right) => left.name.localeCompare(right.name));
    return { totalMissing, missingCards, wildcards };
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

    if (result.missingCards.length === 0) {
      const emptySuccess = document.createElement("p");
      emptySuccess.textContent = "Collection covers this deck. No missing copies.";
      emptySuccess.style.cssText = "margin:8px 0 0";
      resultElement.append(emptySuccess);
    } else {
      const details = document.createElement("details");
      details.style.cssText = "margin-top:8px";
      const detailsSummary = document.createElement("summary");
      detailsSummary.textContent = `Missing card details (${result.missingCards.length})`;
      const table = document.createElement("table");
      table.style.cssText = "border-collapse:collapse;margin-top:6px;text-align:left";
      const head = document.createElement("thead");
      const headingRow = document.createElement("tr");
      for (const label of ["Card name", "Required", "Owned", "Missing", "Craft rarity"]) {
        const cell = document.createElement("th");
        cell.scope = "col";
        cell.textContent = label;
        cell.style.paddingRight = "12px";
        headingRow.append(cell);
      }
      head.append(headingRow);
      const body = document.createElement("tbody");
      for (const missingCard of result.missingCards) {
        const row = document.createElement("tr");
        for (const value of [
          missingCard.name,
          missingCard.required,
          missingCard.owned,
          missingCard.missing,
          missingCard.craftRarity,
        ]) {
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
    resultElement.hidden = false;
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
        count,
        craftRarity: /** @type {CraftRarity} */ (craftRarity),
      };
    }

    return {
      version: 1,
      cards,
      metadata: {
        filename,
        uniqueNameCount: Object.keys(cards).length,
        uploadedAt,
      },
    };
  }

  /** @param {string} value */
  function normalizeName(value) {
    return value
      .normalize("NFKC")
      .replace(/[‘’‛ʼ]/gu, "'")
      .replace(/[‐‑‒–—―]/gu, "-")
      .replace(/\s*\/{2}\s*/gu, " // ")
      .trim()
      .replace(/\s+/gu, " ")
      .toLocaleLowerCase("en-US");
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

  /** @param {unknown} value @returns {value is CollectionSnapshot} */
  function isSnapshot(value) {
    if (!value || typeof value !== "object") return false;
    const candidate = /** @type {Partial<CollectionSnapshot>} */ (value);
    return (
      candidate.version === 1 &&
      !!candidate.cards &&
      typeof candidate.cards === "object" &&
      !!candidate.metadata &&
      typeof candidate.metadata.filename === "string" &&
      Number.isInteger(candidate.metadata.uniqueNameCount) &&
      typeof candidate.metadata.uploadedAt === "string"
    );
  }
})();

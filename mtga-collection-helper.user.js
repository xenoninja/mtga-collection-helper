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
  const tampermonkey = /** @type {{
    getValue: (key: string, fallback: unknown) => Promise<unknown> | unknown,
    setValue: (key: string, value: unknown) => Promise<void> | void
  }} */ (/** @type {any} */ (globalThis).GM);

  /** @typedef {{count: number, craftRarity: CraftRarity}} CollectionEntry */
  /** @typedef {{filename: string, uniqueNameCount: number, uploadedAt: string}} SnapshotMetadata */
  /** @typedef {{version: 1, cards: Record<string, CollectionEntry>, metadata: SnapshotMetadata}} CollectionSnapshot */

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

  controls.append(uploadLabel, checkButton);
  surface.append(title, controls, metadataElement, error);
  deckList.parentElement.insertBefore(surface, deckList);

  const restoration = restoreSnapshot();
  let pendingWork = restoration;
  void restoration.finally(() => {
    if (pendingWork === restoration) uploadInput.disabled = false;
  });
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

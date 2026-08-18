import { expect, test } from "@playwright/test";
import { readFile } from "node:fs/promises";

const userscript = await readFile(
  new URL("../mtga-collection-helper.user.js", import.meta.url),
  "utf8",
);

const header = "Id,Name,Set,Color,Rarity,Count";

/**
 * @typedef {{name: string, quantity: number}} DeckCard
 */

/**
 * @param {import("@playwright/test").Page} page
 * @param {DeckCard[]} cards
 * @param {"visual" | "condensedTable"} startingView
 */
async function mountDeck(page, cards, startingView = "visual") {
  const groupCount = cards.reduce((total, card) => total + card.quantity, 0);
  const textRows = cards
    .map(
      (card, index) => `
        <li data-hash="card-${index}">
          <div><div>${card.quantity}</div></div>
          <div><a href="/cards/card-${index}">${card.name}</a></div>
        </li>`,
    )
    .join("");

  await page.exposeFunction("__gmGetValue", async (
    /** @type {string} */ _key,
    /** @type {unknown} */ fallback,
  ) => fallback);
  await page.exposeFunction("__gmSetValue", async () => {});
  await page.setContent(`
    <main>
      <h1>Example deck</h1>
      <section data-testid="deck-list" aria-label="Deck list">
        <h2>Deck List</h2>
        <label for="viewMode">View</label>
        <select name="viewMode" id="viewMode">
          <option value="table">Text</option>
          <option value="condensedTable">Condensed Text</option>
          <option value="visual">Visual Grid</option>
        </select>
        <div id="rendered-deck"><p>Visual deck</p></div>
      </section>
    </main>
  `);
  await page.evaluate(
    ({ initialView, renderedTextRows, renderedGroupCount }) => {
      const scope = /** @type {any} */ (globalThis);
      scope.GM = {
        getValue: scope.__gmGetValue,
        setValue: scope.__gmSetValue,
      };
      const view = /** @type {HTMLSelectElement} */ (
        document.querySelector('select[name="viewMode"]')
      );
      const renderedDeck = /** @type {HTMLElement} */ (
        document.querySelector("#rendered-deck")
      );
      const render = () => {
        renderedDeck.innerHTML =
          view.value === "table"
            ? `<article><ul>
                <li><button type="button">Creatures (${renderedGroupCount})</button></li>
                ${renderedTextRows}
              </ul></article>`
            : `<p>${view.selectedOptions[0]?.textContent ?? "Deck"} deck</p>`;
      };
      view.value = initialView;
      render();
      view.addEventListener("change", () => setTimeout(render, 25));
    },
    {
      initialView: startingView,
      renderedTextRows: textRows,
      renderedGroupCount: groupCount,
    },
  );
  await page.addScriptTag({ content: userscript });
}

/**
 * @param {import("@playwright/test").Page} page
 * @param {string} csv
 */
async function uploadCollection(page, csv) {
  await page.getByLabel("Upload collection CSV").setInputFiles({
    name: "collection.csv",
    mimeType: "text/csv",
    buffer: Buffer.from(csv),
  });
  await expect(page.getByRole("button", { name: "Check", exact: true })).toBeEnabled();
}

test("checks a mainboard deck after a click and restores the selected view", async ({
  page,
}) => {
  await mountDeck(page, [
    { name: "Llanowar Elves", quantity: 4 },
    { name: "Consider", quantity: 1 },
    { name: "Wedding Announcement", quantity: 2 },
    { name: "Sheoldred, the Apocalypse", quantity: 4 },
  ]);
  const collection = [
    header,
    "1,Llanowar Elves,FDN,G,Common,2",
    "2,Consider,MID,U,Uncommon,0",
    "3,Wedding Announcement,VOW,W,Rare,1",
    '4,"Sheoldred, the Apocalypse",DMU,B,Mythic,3',
  ].join("\n");
  const helper = page.getByRole("region", { name: "MTGA Collection Helper" });
  const view = page.getByLabel("View");

  await uploadCollection(page, collection);

  await expect(view).toHaveValue("visual");
  await expect(helper.getByRole("region", { name: "Deck check result" })).toHaveCount(0);

  await page.getByRole("button", { name: "Check", exact: true }).click();

  await expect(view).toHaveValue("visual");
  await expect(page.getByText("Visual Grid deck", { exact: true })).toBeVisible();
  const result = helper.getByRole("region", { name: "Deck check result" });
  await expect(result).toBeVisible();
  await expect(result).toContainText("5 missing copies across 4 distinct missing cards.");
  const wildcards = result.locator("dl");
  await expect(wildcards.getByText("Common", { exact: true }).locator("..")).toContainText("2");
  await expect(wildcards.getByText("Uncommon", { exact: true }).locator("..")).toContainText("1");
  await expect(wildcards.getByText("Rare", { exact: true }).locator("..")).toContainText("1");
  await expect(wildcards.getByText("Mythic", { exact: true }).locator("..")).toContainText("1");

  const details = result.getByText("Missing card details (4)", { exact: true });
  await expect(details).toBeVisible();
  await details.click();
  const sheoldredRow = result.getByRole("row", {
    name: "Sheoldred, the Apocalypse 4 3 1 Mythic",
  });
  await expect(sheoldredRow).toBeVisible();
  await expect(result.getByRole("row", { name: "Llanowar Elves 4 2 2 Common" })).toBeVisible();
  await expect(helper.getByRole("region", { name: "Deck check result" })).toHaveCount(1);
  await expect(page.locator('[data-testid="deck-list"] #mtga-collection-helper')).toHaveCount(0);
});

test("shows an explicit success when the collection covers the deck", async ({ page }) => {
  await mountDeck(
    page,
    [
      { name: "Lightning Bolt", quantity: 4 },
      { name: "Opt", quantity: 2 },
    ],
    "condensedTable",
  );
  await uploadCollection(
    page,
    [header, "1,Lightning Bolt,STA,R,Common,4", "2,Opt,STA,U,Common,4"].join("\n"),
  );

  await page.getByRole("button", { name: "Check", exact: true }).click();

  await expect(page.getByLabel("View")).toHaveValue("condensedTable");
  const result = page.getByRole("region", { name: "Deck check result" });
  await expect(result).toContainText("Collection covers this deck. No missing copies.");
  await expect(result).toContainText("0 missing copies across 0 distinct missing cards.");
  await expect(result.getByText(/Missing card details/)).toHaveCount(0);
});

import { expect, test } from "@playwright/test";
import { readFile } from "node:fs/promises";

const userscript = await readFile(
  new URL("../mtga-collection-helper.user.js", import.meta.url),
  "utf8",
);

const header = "Id,Name,Set,Color,Rarity,Count";

/**
 * @typedef {{name: string, quantity: number | string, paintKey?: string}} DeckCard
 * @typedef {{name?: string, cards: DeckCard[], displayedCount?: number}} DeckGroup
 * @typedef {{
 *   startingView?: "visual" | "condensedTable",
 *   hiddenResponsiveGroups?: DeckGroup[],
 *   additionalVisibleDeck?: boolean,
 *   renderText?: boolean,
 *   failRestoration?: boolean
 * }} DeckOptions
 */

/**
 * @param {DeckGroup[]} groups
 * @param {string} keyPrefix
 */
function renderTextGroups(groups, keyPrefix) {
  return groups
    .map((group, groupIndex) => {
      const displayedCount =
        group.displayedCount ??
        group.cards.reduce(
          (total, card) =>
            total + (typeof card.quantity === "number" ? card.quantity : 0),
          0,
        );
      const heading =
        group.name === undefined
          ? ""
          : `<li><button type="button">${group.name} (${displayedCount})</button></li>`;
      const rows = group.cards
        .map(
          (card, cardIndex) => `
            <li data-hash="${card.paintKey ?? `${keyPrefix}-${groupIndex}-${cardIndex}`}">
              <div><div>${card.quantity}</div></div>
              <div><a href="/cards/${keyPrefix}-${groupIndex}-${cardIndex}">${card.name}</a></div>
            </li>`,
        )
        .join("");
      return `<article><ul>${heading}${rows}</ul></article>`;
    })
    .join("");
}

/**
 * @param {import("@playwright/test").Page} page
 * @param {DeckGroup[]} groups
 * @param {DeckOptions} options
 */
async function mountDeck(page, groups, options = {}) {
  const {
    startingView = "visual",
    hiddenResponsiveGroups = [],
    additionalVisibleDeck = false,
    renderText = true,
    failRestoration = false,
  } = options;
  const textGroups = renderTextGroups(groups, "active");
  const hiddenGroups = renderTextGroups(hiddenResponsiveGroups, "hidden");
  const extraDeck = additionalVisibleDeck
    ? `<section aria-label="Deck list">
        <h2>Deck List</h2>
        <article><ul><li>Creatures (1)</li></ul></article>
      </section>`
    : "";

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
      <section aria-label="Deck list" hidden>
        <h2>Deck List</h2>
        ${hiddenGroups}
      </section>
      ${extraDeck}
    </main>
  `);
  await page.evaluate(
    ({ initialView, renderedTextGroups, shouldRenderText, shouldFailRestoration }) => {
      const scope = /** @type {any} */ (globalThis);
      scope.GM = {
        getValue: scope.__gmGetValue,
        setValue: scope.__gmSetValue,
      };
      scope.__deckFixture = {
        textGroups: renderedTextGroups,
        renderText: shouldRenderText,
        failRestoration: shouldFailRestoration,
      };
      const view = /** @type {HTMLSelectElement} */ (
        document.querySelector('select[name="viewMode"]')
      );
      const renderedDeck = /** @type {HTMLElement} */ (
        document.querySelector("#rendered-deck")
      );
      const render = () => {
        if (view.value === "table" && scope.__deckFixture.renderText) {
          renderedDeck.innerHTML = scope.__deckFixture.textGroups;
        } else {
          renderedDeck.innerHTML = `<p>${view.selectedOptions[0]?.textContent ?? "Deck"} deck</p>`;
        }
      };
      view.value = initialView;
      render();
      view.addEventListener("change", () => {
        setTimeout(() => {
          if (scope.__deckFixture.failRestoration && view.value !== "table") {
            view.value = "table";
            return;
          }
          render();
        }, 25);
      });
    },
    {
      initialView: startingView,
      renderedTextGroups: textGroups,
      shouldRenderText: renderText,
      shouldFailRestoration: failRestoration,
    },
  );
  await page.addScriptTag({ content: userscript });
}

/**
 * @param {import("@playwright/test").Page} page
 * @param {DeckGroup[]} groups
 * @param {{renderText?: boolean, failRestoration?: boolean}} options
 */
async function updateDeckFixture(page, groups, options = {}) {
  await page.evaluate(
    ({ textGroups, fixtureOptions }) => {
      const fixture = /** @type {any} */ (globalThis).__deckFixture;
      fixture.textGroups = textGroups;
      Object.assign(fixture, fixtureOptions);
    },
    {
      textGroups: renderTextGroups(groups, "updated"),
      fixtureOptions: options,
    },
  );
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
    {
      name: "Creatures",
      cards: [
        { name: "Llanowar Elves", quantity: 4 },
        { name: "Consider", quantity: 1 },
        { name: "Wedding Announcement", quantity: 2 },
        { name: "Sheoldred, the Apocalypse", quantity: 4 },
      ],
    },
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
      {
        name: "Instants",
        cards: [
          { name: "Lightning Bolt", quantity: 4 },
          { name: "Opt", quantity: 2 },
        ],
      },
    ],
    { startingView: "condensedTable" },
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

test("combines every imported group and ignores non-imported and hidden groups", async ({
  page,
}) => {
  const includedGroups = [
    { name: "Creatures", cards: [{ name: "Creature Card", quantity: 1 }] },
    { name: "Instants", cards: [{ name: "Instant Card", quantity: 1 }] },
    { name: "Sorceries", cards: [{ name: "Sorcery Card", quantity: 1 }] },
    { name: "Artifacts", cards: [{ name: "Artifact Card", quantity: 1 }] },
    { name: "Enchantments", cards: [{ name: "Enchantment Card", quantity: 1 }] },
    { name: "Lands", cards: [{ name: "Land Card", quantity: 1 }] },
    { name: "Planeswalkers", cards: [{ name: "Planeswalker Card", quantity: 1 }] },
    { name: "Battles", cards: [{ name: "Battle Card", quantity: 1 }] },
    {
      name: "Sideboard",
      cards: [
        { name: "Creature Card", quantity: 1 },
        { name: "Sideboard Companion", quantity: 1 },
      ],
    },
    { name: "Commander", cards: [{ name: "Commander Card", quantity: 1 }] },
    { name: "Partner", cards: [{ name: "Partner Card", quantity: 1 }] },
    { name: "Companion", cards: [{ name: "Companion Card", quantity: 1 }] },
  ];
  const excludedGroups = [
    "Considering",
    "Maybeboard",
    "Tokens",
    "Attractions",
    "Stickers",
    "Contraptions",
    "Planes",
    "Schemes",
    "Draft Notes",
  ].map((name) => ({
    name,
    cards: [{ name: `${name} Card`, quantity: 1 }],
  }));
  await mountDeck(page, [...includedGroups, ...excludedGroups], {
    hiddenResponsiveGroups: includedGroups,
  });
  const allCardNames = new Set(
    [...includedGroups, ...excludedGroups]
      .flatMap((group) => group.cards)
      .map((card) => card.name),
  );
  const collection = [
    header,
    ...Array.from(allCardNames, (name, index) => `${index + 1},${name},TST,C,Common,0`),
  ].join("\n");

  await uploadCollection(page, collection);
  await page.getByRole("button", { name: "Check", exact: true }).click();

  await expect(page.getByLabel("View")).toHaveValue("visual");
  const result = page.getByRole("region", { name: "Deck check result" });
  await expect(result).toContainText("13 missing copies across 12 distinct missing cards.");
  await result.getByText("Missing card details (12)", { exact: true }).click();
  await expect(
    result.getByRole("row", { name: "Creature Card 2 0 2 Common" }),
  ).toBeVisible();
  await expect(
    result.getByRole("row", { name: "Sideboard Companion 1 0 1 Common" }),
  ).toBeVisible();
  for (const group of excludedGroups) {
    await expect(result.getByText(group.cards[0].name, { exact: true })).toHaveCount(0);
  }
});

test("aggregates distinct painted rows for the same card name", async ({ page }) => {
  await mountDeck(page, [
    {
      name: "Creatures",
      cards: [
        { name: "Shared Card", quantity: 1 },
        { name: "Shared Card", quantity: 1 },
      ],
    },
  ]);
  await uploadCollection(page, [header, "1,Shared Card,TST,C,Common,0"].join("\n"));

  await page.getByRole("button", { name: "Check", exact: true }).click();

  const result = page.getByRole("region", { name: "Deck check result" });
  await expect(result).toContainText("2 missing copies across 1 distinct missing cards.");
  await result.getByText("Missing card details (1)", { exact: true }).click();
  await expect(result.getByRole("row", { name: "Shared Card 2 0 2 Common" })).toBeVisible();
});

test("calculates global playset requirements at each craft rarity", async ({ page }) => {
  await mountDeck(page, [
    {
      name: "Creatures",
      cards: [
        { name: "Common Zero", quantity: 1 },
        { name: "Uncommon Partial", quantity: 3 },
        { name: "Rare Complete", quantity: 2 },
        { name: "Mythic Overplayset", quantity: 3 },
      ],
    },
    {
      name: "Sideboard",
      cards: [{ name: "Mythic Overplayset", quantity: 3 }],
    },
  ]);
  await uploadCollection(
    page,
    [
      header,
      "101,Common Zero,SET-A,W,Common,0",
      "202,Uncommon Partial,SET-B,U,Uncommon,1",
      "303,Rare Complete,SET-C,B,Rare,4",
      "404,Mythic Overplayset,SET-D,R,Mythic,1",
    ].join("\n"),
  );

  await page.getByRole("button", { name: "Check", exact: true }).click();

  const result = page.getByRole("region", { name: "Deck check result" });
  await expect(result).toContainText("6 missing copies across 3 distinct missing cards.");
  const wildcards = result.locator("dl");
  await expect(wildcards.getByText("Common", { exact: true }).locator("..")).toContainText("1");
  await expect(wildcards.getByText("Uncommon", { exact: true }).locator("..")).toContainText("2");
  await expect(wildcards.getByText("Rare", { exact: true }).locator("..")).toContainText("0");
  await expect(wildcards.getByText("Mythic", { exact: true }).locator("..")).toContainText("3");
  await result.getByText("Missing card details (3)", { exact: true }).click();
  await expect(
    result.getByRole("row", { name: "Mythic Overplayset 4 1 3 Mythic" }),
  ).toBeVisible();
  await expect(result.getByText("Rare Complete", { exact: true })).toHaveCount(0);
});

test("matches deterministic card-name normalization without fuzzy guesses", async ({ page }) => {
  await mountDeck(page, [
    {
      name: "Instants",
      cards: [
        { name: "  KAYA’S   GUILE  ", quantity: 1 },
        { name: "Wear / Tear", quantity: 1 },
        { name: "Fire ∕ Ice", quantity: 1 },
        { name: "Dash—Named Card", quantity: 1 },
      ],
    },
  ]);
  await uploadCollection(
    page,
    [
      header,
      "1,kaya's guile,TST,W,Rare,4",
      "2,Wear // Tear,TST,R,Uncommon,4",
      "3,Fire // Ice,TST,U,Uncommon,4",
      "4,dash-named card,TST,C,Common,4",
    ].join("\n"),
  );

  await page.getByRole("button", { name: "Check", exact: true }).click();

  const result = page.getByRole("region", { name: "Deck check result" });
  await expect(result).toContainText("0 missing copies across 0 distinct missing cards.");
  await expect(result).toContainText("Collection covers this deck. No missing copies.");
});

test("treats named basics and every Basic-rarity collection entry as free", async ({ page }) => {
  const freelyAvailableBasics = [
    "Plains",
    "Island",
    "Swamp",
    "Mountain",
    "Forest",
    "Wastes",
    "Snow-Covered Plains",
    "Snow-Covered Island",
    "Snow-Covered Swamp",
    "Snow-Covered Mountain",
    "Snow-Covered Forest",
    "Special Basic",
  ];
  await mountDeck(page, [
    {
      name: "Lands",
      cards: freelyAvailableBasics.map((name) => ({ name, quantity: 20 })),
    },
  ]);
  await uploadCollection(
    page,
    [header, "1,Special Basic,TST,C,Basic,0"].join("\n"),
  );

  await page.getByRole("button", { name: "Check", exact: true }).click();

  const result = page.getByRole("region", { name: "Deck check result" });
  await expect(result).toContainText("0 missing copies across 0 distinct missing cards.");
  await expect(result).toContainText("Collection covers this deck. No missing copies.");
  await expect(result.getByText(/card details/i)).toHaveCount(0);
});

test("reports aggregated unmatched cards separately from known requirements", async ({ page }) => {
  await mountDeck(page, [
    {
      name: "Creatures",
      cards: [
        { name: "Lightning Bolt", quantity: 2 },
        { name: "Similar Card", quantity: 3 },
      ],
    },
    {
      name: "Sideboard",
      cards: [{ name: "  similar   card  ", quantity: 2 }],
    },
  ]);
  await uploadCollection(
    page,
    [
      header,
      "1,Lightning Bolt,TST,R,Common,1",
      "2,Similar Cards,TST,U,Rare,4",
    ].join("\n"),
  );

  await page.getByRole("button", { name: "Check", exact: true }).click();

  const result = page.getByRole("region", { name: "Deck check result" });
  await expect(result).toContainText("1 missing copies across 1 distinct missing cards.");
  const wildcards = result.locator("dl");
  await expect(wildcards.getByText("Common", { exact: true }).locator("..")).toContainText("1");
  await expect(wildcards.getByText("Rare", { exact: true }).locator("..")).toContainText("0");
  await result.getByText("Unmatched card details (1)", { exact: true }).click();
  await expect(
    result.getByRole("row", {
      name: "Similar Card 5 Unknown No collection match",
    }),
  ).toBeVisible();
  await expect(result.getByText("Similar Cards", { exact: true })).toHaveCount(0);
});

const extractionFailures = [
  {
    name: "missing heading",
    groups: [{ cards: [{ name: "Broken Card", quantity: 1 }] }],
    error: "no displayed heading and card count",
  },
  {
    name: "unparseable quantity",
    groups: [{ name: "Creatures", cards: [{ name: "Broken Card", quantity: "two" }] }],
    error: 'Could not read the quantity for "Broken Card"',
  },
  {
    name: "duplicate painted row",
    groups: [
      {
        name: "Creatures",
        cards: [
          { name: "Repeated Card", quantity: 1, paintKey: "same-painted-row" },
          { name: "Repeated Card", quantity: 1, paintKey: "same-painted-row" },
        ],
      },
    ],
    error: "contains a duplicate painted row",
  },
  {
    name: "displayed count mismatch",
    groups: [
      {
        name: "Creatures",
        displayedCount: 2,
        cards: [{ name: "Broken Card", quantity: 1 }],
      },
    ],
    error: "Deck group count mismatch: Moxfield shows 2, but 1 copies were read",
  },
];

for (const failure of extractionFailures) {
  test(`fails closed for ${failure.name} and restores the original view`, async ({ page }) => {
    await mountDeck(page, failure.groups);
    await uploadCollection(page, [header, "1,Broken Card,TST,C,Common,0"].join("\n"));

    await page.getByRole("button", { name: "Check", exact: true }).click();

    await expect(page.getByRole("alert")).toContainText(failure.error, { timeout: 7_000 });
    await expect(page.getByLabel("View")).toHaveValue("visual");
    await expect(page.getByText("Visual Grid deck", { exact: true })).toBeVisible();
    await expect(page.getByRole("region", { name: "Deck check result" })).toHaveCount(0);
  });
}

test("fails closed when more than one visible deck list is active", async ({ page }) => {
  await mountDeck(
    page,
    [{ name: "Creatures", cards: [{ name: "Broken Card", quantity: 1 }] }],
    { additionalVisibleDeck: true },
  );
  await uploadCollection(page, [header, "1,Broken Card,TST,C,Common,0"].join("\n"));

  await page.getByRole("button", { name: "Check", exact: true }).click();

  await expect(page.getByRole("alert")).toContainText(
    "Found more than one active Moxfield deck list",
  );
  await expect(page.getByLabel("View")).toHaveValue("visual");
  await expect(page.getByRole("region", { name: "Deck check result" })).toHaveCount(0);
});

test("fails closed on a Text-view render timeout and restores the original view", async ({
  page,
}) => {
  await mountDeck(
    page,
    [{ name: "Creatures", cards: [{ name: "Broken Card", quantity: 1 }] }],
    { renderText: false },
  );
  await uploadCollection(page, [header, "1,Broken Card,TST,C,Common,0"].join("\n"));

  await page.getByRole("button", { name: "Check", exact: true }).click();

  await expect(page.getByRole("alert")).toContainText(
    "Moxfield Text view did not stabilize",
    { timeout: 7_000 },
  );
  await expect(page.getByLabel("View")).toHaveValue("visual");
  await expect(page.getByText("Visual Grid deck", { exact: true })).toBeVisible();
  await expect(page.getByRole("region", { name: "Deck check result" })).toHaveCount(0);
});

test("clears a previous result when later extraction fails", async ({ page }) => {
  const validGroups = [
    { name: "Creatures", cards: [{ name: "Deck Card", quantity: 1 }] },
  ];
  await mountDeck(page, validGroups);
  await uploadCollection(page, [header, "1,Deck Card,TST,C,Common,0"].join("\n"));
  await page.getByRole("button", { name: "Check", exact: true }).click();
  await expect(page.getByRole("region", { name: "Deck check result" })).toBeVisible();

  await updateDeckFixture(page, [
    { name: "Creatures", cards: [{ name: "Deck Card", quantity: "many" }] },
  ]);
  await page.getByRole("button", { name: "Check", exact: true }).click();

  await expect(page.getByRole("region", { name: "Deck check result" })).toHaveCount(0);
  await expect(page.getByRole("alert")).toContainText("Could not read the quantity", {
    timeout: 7_000,
  });
  await expect(page.getByLabel("View")).toHaveValue("visual");
});

test("reports restoration failure and suppresses a newly extracted result", async ({ page }) => {
  const groups = [{ name: "Creatures", cards: [{ name: "Deck Card", quantity: 1 }] }];
  await mountDeck(page, groups);
  await uploadCollection(page, [header, "1,Deck Card,TST,C,Common,0"].join("\n"));
  await page.getByRole("button", { name: "Check", exact: true }).click();
  await expect(page.getByRole("region", { name: "Deck check result" })).toBeVisible();

  await updateDeckFixture(page, groups, { failRestoration: true });
  await page.getByRole("button", { name: "Check", exact: true }).click();

  await expect(page.getByRole("alert")).toContainText(
    "Could not restore the Moxfield view",
    { timeout: 7_000 },
  );
  await expect(page.getByRole("region", { name: "Deck check result" })).toHaveCount(0);
});

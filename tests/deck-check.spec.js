import { expect, test } from "@playwright/test";
import { readFile } from "node:fs/promises";

const userscript = await readFile(
  new URL("../mtga-collection-helper.user.js", import.meta.url),
  "utf8",
);

const header = "Id,Name,Set,Color,Rarity,Count";

/**
 * @typedef {{name: string, quantity: number | string, paintKey?: string}} DeckCard
 * @typedef {{name?: string, cards: DeckCard[], displayedCount?: number, headingSuffix?: string}} DeckGroup
 * @typedef {{
 *   startingView?: "visual" | "condensedTable",
 *   startingGroup?: "type" | "tag",
 *   taggedGroups?: DeckGroup[],
 *   hiddenResponsiveGroups?: DeckGroup[],
 *   additionalVisibleDeck?: boolean,
 *   renderText?: boolean,
 *   failRestoration?: boolean,
 *   renderDelay?: number,
 *   liveSemanticMount?: boolean
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
          : `<li><button type="button">${group.name} (${displayedCount})</button>${
              group.headingSuffix ? `<span>${group.headingSuffix}</span>` : ""
            }</li>`;
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

/** @param {boolean} liveSemanticMount */
function renderDeckListShell(liveSemanticMount = false) {
  const semanticAttributes = liveSemanticMount
    ? ""
    : ' data-testid="deck-list" aria-label="Deck list"';
  return `<section${semanticAttributes}>
    <h2 class="visually-hidden">Deck List</h2>
    <label for="viewMode">View</label>
    <select name="viewMode" id="viewMode">
      <option value="table">Text</option>
      <option value="condensedTable">Condensed Text</option>
      <option value="visual">Visual Grid</option>
    </select>
    <label for="groupBy">Group</label>
    <select name="groupBy" id="groupBy">
      <option value="type">Type</option>
      <option value="tag">Type &amp; Tags</option>
    </select>
    <div id="rendered-deck"><p>Visual deck</p></div>
  </section>`;
}

/**
 * @param {import("@playwright/test").Page} page
 * @param {DeckGroup[]} groups
 * @param {DeckOptions} options
 */
async function mountDeck(page, groups, options = {}) {
  const {
    startingView = "visual",
    startingGroup = "type",
    taggedGroups = groups,
    hiddenResponsiveGroups = [],
    additionalVisibleDeck = false,
    renderText = true,
    failRestoration = false,
    renderDelay = 25,
    liveSemanticMount = false,
  } = options;
  const textGroups = renderTextGroups(groups, "active");
  const taggedTextGroups = renderTextGroups(taggedGroups, "tagged");
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
  await page.route("https://www.moxfield.com/**", async (route) => {
    await route.fulfill({ contentType: "text/html", body: "" });
  });
  await page.goto("https://www.moxfield.com/decks/deck-one");
  await page.setContent(`
    <main>
      <h1>Example deck</h1>
      ${renderDeckListShell(liveSemanticMount)}
      <section aria-label="Deck list" hidden>
        <h2>Deck List</h2>
        ${hiddenGroups}
      </section>
      ${extraDeck}
    </main>
  `);
  await page.evaluate(
    ({
      initialView,
      initialGroup,
      renderedTextGroups,
      renderedTaggedTextGroups,
      shouldRenderText,
      shouldFailRestoration,
      fixtureRenderDelay,
    }) => {
      const scope = /** @type {any} */ (globalThis);
      scope.GM = {
        getValue: scope.__gmGetValue,
        setValue: scope.__gmSetValue,
      };
      scope.__deckFixture = {
        textGroups: renderedTextGroups,
        taggedTextGroups: renderedTaggedTextGroups,
        renderText: shouldRenderText,
        failRestoration: shouldFailRestoration,
        renderDelay: fixtureRenderDelay,
      };
      /** @param {string} initialView @param {string} initialGroup */
      scope.__bindDeckFixture = (initialView, initialGroup) => {
        const view = /** @type {HTMLSelectElement} */ (
          document.querySelector('select[name="viewMode"]')
        );
        const group = /** @type {HTMLSelectElement} */ (
          document.querySelector('select[name="groupBy"]')
        );
        const renderedDeck = /** @type {HTMLElement} */ (
          document.querySelector("#rendered-deck")
        );
        const render = () => {
          if (view.value === "table" && scope.__deckFixture.renderText) {
            renderedDeck.innerHTML =
              group.value === "type"
                ? scope.__deckFixture.textGroups
                : scope.__deckFixture.taggedTextGroups;
          } else {
            renderedDeck.innerHTML = `<p>${view.selectedOptions[0]?.textContent ?? "Deck"} deck</p>`;
          }
        };
        view.value = initialView;
        group.value = initialGroup;
        render();
        const scheduleRender = () => {
          setTimeout(() => {
            if (scope.__deckFixture.failRestoration && view.value !== "table") {
              view.value = "table";
              return;
            }
            render();
          }, scope.__deckFixture.renderDelay);
        };
        view.addEventListener("change", scheduleRender);
        group.addEventListener("change", scheduleRender);
      };
      scope.__bindDeckFixture(initialView, initialGroup);
    },
    {
      initialView: startingView,
      initialGroup: startingGroup,
      renderedTextGroups: textGroups,
      renderedTaggedTextGroups: taggedTextGroups,
      shouldRenderText: renderText,
      shouldFailRestoration: failRestoration,
      fixtureRenderDelay: renderDelay,
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
 * @param {DeckGroup[]} groups
 * @param {{
 *   deckId: string,
 *   startingView?: "visual" | "condensedTable",
 *   replaceDeckDom?: boolean
 * }} options
 */
async function navigateDeckFixture(page, groups, options) {
  const { deckId, startingView = "visual", replaceDeckDom = true } = options;
  await page.evaluate(
    ({ nextDeckId, initialView, textGroups, shouldReplaceDeckDom, deckListHtml }) => {
      const scope = /** @type {any} */ (globalThis);
      scope.__deckFixture.textGroups = textGroups;
      scope.__deckFixture.renderText = true;
      scope.__deckFixture.failRestoration = false;
      history.pushState({}, "", `/decks/${nextDeckId}`);
      if (!shouldReplaceDeckDom) return;

      const main = document.querySelector("main");
      if (!main) throw new Error("Deck fixture has no main element.");
      main.innerHTML = `<h1>Example deck ${nextDeckId}</h1>${deckListHtml}`;
      scope.__deckFixture.renderDelay = 25;
      scope.__bindDeckFixture(initialView, "type");
    },
    {
      nextDeckId: deckId,
      initialView: startingView,
      textGroups: renderTextGroups(groups, deckId),
      shouldReplaceDeckDom: replaceDeckDom,
      deckListHtml: renderDeckListShell(),
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

test("mounts beside the live semantic deck list without generated selectors", async ({
  page,
}) => {
  await mountDeck(
    page,
    [{ name: "Creatures", cards: [{ name: "Llanowar Elves", quantity: 1 }] }],
    { liveSemanticMount: true },
  );

  const helper = page.getByRole("region", { name: "MTGA Collection Helper" });
  await expect(helper).toBeVisible();
  await expect
    .poll(() =>
      helper.evaluate((element) => ({
        tag: element.nextElementSibling?.tagName ?? null,
        heading:
          element.nextElementSibling?.querySelector(":scope > h2")?.textContent?.trim() ??
          null,
      })),
    )
    .toEqual({ tag: "SECTION", heading: "Deck List" });
});

test("mounts once when the React deck list renders after document idle", async ({ page }) => {
  await page.exposeFunction("__gmGetValue", async (
    /** @type {string} */ _key,
    /** @type {unknown} */ fallback,
  ) => fallback);
  await page.exposeFunction("__gmSetValue", async () => {});
  await page.route("https://www.moxfield.com/**", async (route) => {
    await route.fulfill({ contentType: "text/html", body: "" });
  });
  await page.goto("https://www.moxfield.com/decks/deck-one");
  await page.setContent('<div id="js-reactroot">Loading Moxfield.</div>');
  await page.evaluate(() => {
    const scope = /** @type {any} */ (globalThis);
    scope.GM = {
      getValue: scope.__gmGetValue,
      setValue: scope.__gmSetValue,
    };
  });
  await page.addScriptTag({ content: userscript });

  await expect(page.locator("#mtga-collection-helper")).toHaveCount(0);
  await page.locator("#js-reactroot").evaluate((root, deckListHtml) => {
    root.innerHTML = `<main>${deckListHtml}</main>`;
  }, renderDeckListShell(true));

  const helper = page.getByRole("region", { name: "MTGA Collection Helper" });
  await expect(helper).toBeVisible();
  await expect(page.locator("#mtga-collection-helper")).toHaveCount(1);
  await expect
    .poll(() => helper.evaluate((element) => element.nextElementSibling?.tagName ?? null))
    .toBe("SECTION");
});

test("uses Type grouping for extraction and restores the selected grouping", async ({
  page,
}) => {
  await mountDeck(
    page,
    [{ name: "Creatures", cards: [{ name: "Llanowar Elves", quantity: 1 }] }],
    {
      startingGroup: "tag",
      taggedGroups: [{ name: "Ramp", cards: [{ name: "Llanowar Elves", quantity: 1 }] }],
    },
  );
  await uploadCollection(page, [header, "1,Llanowar Elves,FDN,G,Common,0"].join("\n"));

  await page.getByRole("button", { name: "Check", exact: true }).click();

  await expect(page.getByLabel("Group")).toHaveValue("tag");
  const result = page.getByRole("region", { name: "Deck check result" });
  await expect(result).toContainText("1 missing copies across 1 distinct missing cards.");
});

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

test("extracts lands when Moxfield annotates the heading with MDFC sources", async ({
  page,
}) => {
  await mountDeck(page, [
    {
      name: "Sorceries",
      cards: [{ name: "Agadeem's Awakening", quantity: 1 }],
    },
    {
      name: "Lands",
      headingSuffix: "· 3 including mdfc",
      cards: [
        { name: "Island", quantity: 1 },
        { name: "Watery Grave", quantity: 1 },
      ],
    },
  ]);
  await uploadCollection(
    page,
    [
      header,
      "1,Agadeem's Awakening,ZNR,B,Mythic,0",
      "2,Watery Grave,GRN,U,Rare,0",
    ].join("\n"),
  );

  await page.getByRole("button", { name: "Check", exact: true }).click();

  const result = page.getByRole("region", { name: "Deck check result" });
  await expect(result).toContainText("2 missing copies across 2 distinct missing cards.");
  await result.getByText("Missing card details (2)", { exact: true }).click();
  await expect(
    result.getByRole("row", { name: "Agadeem's Awakening 1 0 1 Mythic" }),
  ).toBeVisible();
  await expect(result.getByRole("row", { name: "Watery Grave 1 0 1 Rare" })).toBeVisible();
  await expect(page.getByRole("alert")).toHaveCount(0);
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
test("aggregates one painted card across mainboard and sideboard", async ({ page }) => {
  await mountDeck(page, [
    {
      name: "Enchantments",
      cards: [{ name: "Eaten by Piranhas", quantity: 2, paintKey: "shared-printing" }],
    },
    {
      name: "Sideboard",
      cards: [{ name: "Eaten by Piranhas", quantity: 2, paintKey: "shared-printing" }],
    },
  ]);
  await uploadCollection(
    page,
    [header, "1,Eaten by Piranhas,LCI,U,Common,0"].join("\n"),
  );

  await page.getByRole("button", { name: "Check", exact: true }).click();

  const result = page.getByRole("region", { name: "Deck check result" });
  await expect(result).toContainText("4 missing copies across 1 distinct missing cards.");
  await result.getByText("Missing card details (1)", { exact: true }).click();
  await expect(
    result.getByRole("row", { name: "Eaten by Piranhas 4 0 4 Common" }),
  ).toBeVisible();
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
    name: "duplicate painted row across repeated group lists",
    groups: [
      {
        name: "Creatures",
        cards: [{ name: "Repeated Card", quantity: 1, paintKey: "same-painted-row" }],
      },
      {
        name: "Creatures",
        cards: [{ name: "Repeated Card", quantity: 1, paintKey: "same-painted-row" }],
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

test("shows one busy check while repeated clicks overlap", async ({ page }) => {
  await mountDeck(
    page,
    [{ name: "Creatures", cards: [{ name: "Deck Card", quantity: 1 }] }],
    { renderDelay: 250 },
  );
  await uploadCollection(page, [header, "1,Deck Card,TST,C,Common,0"].join("\n"));
  const checkButton = page.getByRole("button", { name: "Check", exact: true });

  await checkButton.click();
  await expect(page.getByRole("button", { name: "Checking…", exact: true })).toBeDisabled();
  await page.evaluate(() => {
    document
      .querySelector("#mtga-collection-helper button")
      ?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });

  await expect(page.getByRole("region", { name: "Deck check result" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Check", exact: true })).toBeEnabled();
  await expect(page.locator("#mtga-collection-helper")).toHaveCount(1);
  await page.waitForTimeout(5_200);
  await expect(page.getByRole("alert")).toHaveCount(0);
  await expect(page.getByRole("region", { name: "Deck check result" })).toBeVisible();
});

test("replaces a successful result when checking again", async ({ page }) => {
  await mountDeck(page, [
    { name: "Creatures", cards: [{ name: "Deck Card", quantity: 2 }] },
  ]);
  await uploadCollection(page, [header, "1,Deck Card,TST,C,Common,0"].join("\n"));
  await page.getByRole("button", { name: "Check", exact: true }).click();
  const result = page.getByRole("region", { name: "Deck check result" });
  await expect(result).toContainText("2 missing copies");

  await updateDeckFixture(page, [
    { name: "Creatures", cards: [{ name: "Deck Card", quantity: 1 }] },
  ]);
  await page.getByRole("button", { name: "Check", exact: true }).click();

  await expect(result).toContainText("1 missing copies");
  await expect(page.getByRole("region", { name: "Deck check result" })).toHaveCount(1);
  await expect(page.locator("#mtga-collection-helper")).toHaveCount(1);
});

test("keeps the collection but clears deck state after in-page navigation", async ({
  page,
}) => {
  await mountDeck(page, [
    { name: "Creatures", cards: [{ name: "First Deck Card", quantity: 1 }] },
  ]);
  await uploadCollection(
    page,
    [header, "1,First Deck Card,TST,C,Common,0", "2,Second Deck Card,TST,C,Rare,0"].join(
      "\n",
    ),
  );
  await page.getByRole("button", { name: "Check", exact: true }).click();
  await expect(page.getByRole("region", { name: "Deck check result" })).toContainText(
    "First Deck Card",
  );

  await navigateDeckFixture(
    page,
    [{ name: "Creatures", cards: [{ name: "Second Deck Card", quantity: 1 }] }],
    { deckId: "deck-two" },
  );

  const helper = page.locator("#mtga-collection-helper");
  await expect(helper).toHaveCount(1);
  await expect(helper).toContainText("collection.csv · 2 unique card names");
  await expect(page.getByRole("button", { name: "Check", exact: true })).toBeEnabled();
  await expect(page.getByRole("region", { name: "Deck check result" })).toHaveCount(0);
  await expect(page.getByRole("alert")).toHaveCount(0);
  await page.waitForTimeout(150);
  await expect(page.getByRole("region", { name: "Deck check result" })).toHaveCount(0);

  await page.getByRole("button", { name: "Check", exact: true }).click();
  await expect(page.getByRole("region", { name: "Deck check result" })).toContainText(
    "Second Deck Card",
  );
  await expect(helper).toHaveCount(1);

  await page.getByLabel("View").evaluate((view) => view.remove());
  await page.getByRole("button", { name: "Check", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText("Could not find Moxfield's View control");

  await navigateDeckFixture(
    page,
    [{ name: "Creatures", cards: [{ name: "Second Deck Card", quantity: 1 }] }],
    { deckId: "deck-three" },
  );
  await expect(page.getByRole("alert")).toHaveCount(0);
  await expect(page.getByRole("region", { name: "Deck check result" })).toHaveCount(0);
  await expect(helper).toContainText("collection.csv · 2 unique card names");

  await page.evaluate(() => history.pushState({}, "", "/account"));
  await expect(helper).toHaveCount(0);
  await page.evaluate(() => history.pushState({}, "", "/decks/deck-four"));
  await expect(helper).toHaveCount(1);
  await expect(helper).toContainText("collection.csv · 2 unique card names");
});

test("discards an active check when navigating to another deck", async ({ page }) => {
  await mountDeck(
    page,
    [{ name: "Creatures", cards: [{ name: "First Deck Card", quantity: 1 }] }],
    { renderDelay: 250 },
  );
  await uploadCollection(
    page,
    [header, "1,First Deck Card,TST,C,Common,0", "2,Second Deck Card,TST,C,Rare,0"].join(
      "\n",
    ),
  );
  const checkButton = page.getByRole("button", { name: "Check", exact: true });

  await checkButton.click();
  await expect(page.getByRole("button", { name: "Checking…", exact: true })).toBeDisabled();
  await expect(page.getByLabel("View")).toHaveValue("table");
  await navigateDeckFixture(
    page,
    [{ name: "Creatures", cards: [{ name: "Second Deck Card", quantity: 1 }] }],
    { deckId: "deck-two", replaceDeckDom: false },
  );

  await expect(checkButton).toBeEnabled();
  await expect(page.getByLabel("View")).toHaveValue("visual");
  await expect(page.getByText("Visual Grid deck", { exact: true })).toBeVisible();
  await expect(page.getByRole("region", { name: "Deck check result" })).toHaveCount(0);
  await expect(page.getByRole("alert")).toHaveCount(0);
  await expect(page.locator("#mtga-collection-helper")).toContainText(
    "collection.csv · 2 unique card names",
  );
  await page.waitForTimeout(300);
  await expect(page.getByRole("region", { name: "Deck check result" })).toHaveCount(0);

  await checkButton.click();
  await expect(page.getByRole("region", { name: "Deck check result" })).toContainText(
    "Second Deck Card",
  );
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

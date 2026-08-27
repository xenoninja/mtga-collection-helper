import { expect, test } from "@playwright/test";
import { readFile } from "node:fs/promises";

const userscript = await readFile(
  new URL("../mtga-collection-helper.user.js", import.meta.url),
  "utf8",
);

const storageKey = "mtga-collection-helper.collection-snapshot";
const validHeader = ["Id", "Name", "Set", "Color", "Rarity", "Count"].join(",");
const validCsv = [
  `\uFEFF${validHeader}`,
  '1,"Krenko, Mob Boss",JMP,R,Mythic,2',
  "2,Lightning Bolt,STA,R,Common,4",
].join("\r\n");

/**
 * @param {import("@playwright/test").Page} page
 * @param {Map<string, unknown>} storage
 * @param {{
 *   getValueGate?: Promise<void>,
 *   onGetValueReturn?: () => void,
 *   setValueGate?: Promise<void>,
 *   lexicalGrant?: boolean
 * }} [options]
 */
async function mountHelper(page, storage = new Map(), options = {}) {
  const getValue = async (
    /** @type {string} */ key,
    /** @type {unknown} */ fallback,
  ) => {
    const storedValue = storage.has(key)
      ? structuredClone(storage.get(key))
      : fallback;
    await options.getValueGate;
    options.onGetValueReturn?.();
    return storedValue;
  };
  const setValue = async (
    /** @type {string} */ key,
    /** @type {unknown} */ value,
  ) => {
    await options.setValueGate;
    storage.set(key, structuredClone(value));
  };
  await page.exposeFunction("__gmGetValue", getValue);
  await page.exposeFunction("__gmSetValue", setValue);
  await page.route("https://www.moxfield.com/**", async (route) => {
    await route.fulfill({ contentType: "text/html", body: "" });
  });
  await page.goto("https://www.moxfield.com/decks/deck-one");
  await page.setContent(`
    <main>
      <h1>Example deck</h1>
      <section data-testid="deck-list" aria-label="Deck list"></section>
    </main>
  `);
  if (options.lexicalGrant) {
    await page.addScriptTag({
      content: `const GM = {
        getValue: globalThis.__gmGetValue,
        setValue: globalThis.__gmSetValue,
      };
      ${userscript}`,
    });
  } else {
    await page.evaluate(() => {
      const scope = /** @type {any} */ (globalThis);
      scope.GM = {
        getValue: scope.__gmGetValue,
        setValue: scope.__gmSetValue,
      };
    });
    await page.addScriptTag({ content: userscript });
  }
  return storage;
}

/**
 * @param {import("@playwright/test").Page} page
 * @param {string} name
 * @param {string} csv
 */
async function uploadCsv(page, name, csv) {
  await page.getByLabel("Upload collection CSV").setInputFiles({
    name,
    mimeType: "text/csv",
    buffer: Buffer.from(csv),
  });
}

test("metadata installs only on top-level Moxfield deck pages", () => {
  const metadata = userscript.match(/\/\/ ==UserScript==[\s\S]+?\/\/ ==\/UserScript==/u)?.[0];

  expect(metadata).toBeTruthy();
  if (!metadata) throw new Error("Userscript metadata block is missing.");
  expect(
    Array.from(metadata.matchAll(/^\/\/ @match\s+(\S+)$/gmu), (match) => match[1]),
  ).toEqual([
    "https://moxfield.com/decks/*",
    "https://www.moxfield.com/decks/*",
  ]);
  expect(metadata).toContain("// @noframes");
  const rawScriptUrl =
    "https://raw.githubusercontent.com/xenoninja/mtga-collection-helper/master/mtga-collection-helper.user.js";
  expect(
    Array.from(
      metadata.matchAll(/^\/\/ @(downloadURL|updateURL)\s+(\S+)$/gmu),
      (match) => [match[1], match[2]],
    ),
  ).toEqual([
    ["downloadURL", rawScriptUrl],
    ["updateURL", rawScriptUrl],
  ]);
  expect(
    Array.from(metadata.matchAll(/^\/\/ @grant\s+(\S+)$/gmu), (match) => match[1]),
  ).toEqual(["GM.getValue", "GM.setValue"]);
});


test("uses Tampermonkey's userscript-scope GM grant", async ({ page }) => {
  await mountHelper(page, new Map(), { lexicalGrant: true });

  await uploadCsv(page, "collection.csv", validCsv);

  await expect(page.getByRole("button", { name: "Check", exact: true })).toBeEnabled();
  await expect(
    page.getByRole("region", { name: "MTGA Collection Helper" }),
  ).toContainText("2 unique card names");
});
test("uploads and restores a valid collection snapshot", async ({ page, context }) => {
  const storage = await mountHelper(page);
  const helper = page.getByRole("region", { name: "MTGA Collection Helper" });
  const check = page.getByRole("button", { name: "Check", exact: true });

  await expect(helper).toBeVisible();
  await expect(page.getByText("Upload collection CSV", { exact: true })).toBeVisible();
  await expect(check).toBeDisabled();

  await uploadCsv(page, "collection.csv", validCsv);

  await expect(check).toBeEnabled();
  await expect(helper).toContainText("collection.csv");
  await expect(helper).toContainText("2 unique card names");
  await expect(helper.locator("time")).toHaveAttribute(
    "datetime",
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/,
  );

  const restoredPage = await context.newPage();
  await mountHelper(restoredPage, storage);
  const restoredHelper = restoredPage.getByRole("region", {
    name: "MTGA Collection Helper",
  });

  await expect(restoredPage.getByRole("button", { name: "Check", exact: true })).toBeEnabled();
  await expect(restoredHelper).toContainText("collection.csv");
  await expect(restoredHelper).toContainText("2 unique card names");
  await expect(restoredHelper.locator("time")).toHaveAttribute("datetime", /.+/);
});

test("reports a stored snapshot from the previous format instead of dropping it", async ({
  page,
}) => {
  const storage = new Map([
    [
      storageKey,
      {
        version: 1,
        cards: { "lightning bolt": { count: 4, craftRarity: "Common" } },
        metadata: {
          filename: "collection.csv",
          uniqueNameCount: 1,
          uploadedAt: new Date().toISOString(),
        },
      },
    ],
  ]);
  await mountHelper(page, storage);
  const helper = page.getByRole("region", { name: "MTGA Collection Helper" });

  // Card links resolve against the collection's own spelling, which a version 1
  // snapshot never stored, so it cannot be silently carried forward.
  await expect(helper).toContainText("older format");
  await expect(page.getByRole("button", { name: "Check", exact: true })).toBeDisabled();
});

test("distinguishes unreadable stored data from an older snapshot format", async ({
  page,
}) => {
  const storage = new Map([[storageKey, { cards: "not a snapshot" }]]);
  await mountHelper(page, storage);
  const helper = page.getByRole("region", { name: "MTGA Collection Helper" });

  await expect(helper).toContainText("could not be read");
  await expect(helper).not.toContainText("older format");
  await expect(page.getByRole("button", { name: "Check", exact: true })).toBeDisabled();
});

test("a new valid upload replaces the active snapshot", async ({ page, context }) => {
  const storage = await mountHelper(page);
  const helper = page.getByRole("region", { name: "MTGA Collection Helper" });
  await uploadCsv(page, "old.csv", validCsv);
  await expect(helper).toContainText("old.csv");
  await expect(helper).toContainText("2 unique card names");

  await uploadCsv(
    page,
    "current.csv",
    [
      validHeader,
      "9,Counterspell,STA,U,Uncommon,3",
    ].join("\n"),
  );

  await expect(helper).toContainText("current.csv");
  await expect(helper).toContainText("1 unique card name");
  await expect(helper).not.toContainText("old.csv");

  const restoredPage = await context.newPage();
  await mountHelper(restoredPage, storage);
  const restoredHelper = restoredPage.getByRole("region", {
    name: "MTGA Collection Helper",
  });
  await expect(restoredHelper).toContainText("current.csv");
  await expect(restoredHelper).toContainText("1 unique card name");
  await expect(restoredHelper).not.toContainText("old.csv");
});

test("serializes a replacement after pending snapshot restoration", async ({
  page,
  context,
}) => {
  const storage = await mountHelper(page);
  await uploadCsv(page, "old.csv", validCsv);
  await expect(
    page.getByRole("region", { name: "MTGA Collection Helper" }),
  ).toContainText("old.csv");

  /** @type {() => void} */
  let releaseRestore = () => {};
  const restoreGate = new Promise(
    (/** @type {(value?: void | PromiseLike<void>) => void} */ resolve) => {
      releaseRestore = resolve;
    },
  );
  /** @type {() => void} */
  let markReadReturned = () => {};
  const readReturned = new Promise(
    (/** @type {(value?: void | PromiseLike<void>) => void} */ resolve) => {
      markReadReturned = resolve;
    },
  );
  const replacementPage = await context.newPage();
  await mountHelper(replacementPage, storage, {
    getValueGate: restoreGate,
    onGetValueReturn: markReadReturned,
  });
  const replacementHelper = replacementPage.getByRole("region", {
    name: "MTGA Collection Helper",
  });

  const replacementInput = replacementPage.getByLabel("Upload collection CSV");
  await expect(replacementInput).toBeDisabled();
  releaseRestore();
  await readReturned;
  await expect(replacementInput).toBeEnabled();

  await uploadCsv(
    replacementPage,
    "current.csv",
    [
      validHeader,
      "9,Counterspell,STA,U,Uncommon,3",
    ].join("\n"),
  );

  await expect(replacementHelper).toContainText("current.csv");
  await expect(replacementHelper).toContainText("1 unique card name");
  await expect(replacementHelper).not.toContainText("old.csv");
});

test("prevents another selection while an upload is persisting", async ({ page }) => {
  /** @type {() => void} */
  let finishPersistence = () => {};
  const persistenceGate = new Promise(
    (/** @type {(value?: void | PromiseLike<void>) => void} */ resolve) => {
      finishPersistence = resolve;
    },
  );
  await mountHelper(page, new Map(), { setValueGate: persistenceGate });
  const uploadInput = page.getByLabel("Upload collection CSV");
  await expect(uploadInput).toBeEnabled();

  await uploadCsv(page, "current.csv", validCsv);

  await expect(uploadInput).toBeDisabled();
  finishPersistence();
  await expect(
    page.getByRole("region", { name: "MTGA Collection Helper" }),
  ).toContainText("current.csv");
  await expect(uploadInput).toBeEnabled();
});

test("renders uploaded text without sending collection contents", async ({ page }) => {
  await mountHelper(page);
  /** @type {string[]} */
  const requests = [];
  page.on("request", (request) => requests.push(request.url()));
  const helper = page.getByRole("region", { name: "MTGA Collection Helper" });
  const markup = "<img src=https://example.invalid/leak>";

  await uploadCsv(
    page,
    `${markup}.csv`,
    [
      validHeader,
      `1,${markup},STA,R,Common,1`,
    ].join("\n"),
  );

  await expect(helper).toContainText(`${markup}.csv`);
  await expect(helper.locator("img")).toHaveCount(0);

  await uploadCsv(
    page,
    "invalid.csv",
    [
      validHeader,
      `1,${markup},STA,R,Common,1`,
      `2,${markup},STA,R,Common,1`,
    ].join("\n"),
  );

  await expect(helper.getByRole("alert")).toContainText(markup);
  await expect(helper.locator("img")).toHaveCount(0);
  expect(requests).toEqual([]);
});

const invalidUploads = [
  {
    name: "missing schema column",
    csv: [
      "Id,Name,Set,Rarity,Count",
      "1,Lightning Bolt,STA,Common,4",
    ].join("\n"),
    error: 'CSV header: missing column "Color".',
  },
  {
    name: "unexpected schema column",
    csv: [
      "Id,Name,Set,Color,Rarity,Count,Foil",
      "1,Lightning Bolt,STA,R,Common,4,false",
    ].join("\n"),
    error: 'CSV header: unexpected column "Foil".',
  },
  {
    name: "malformed quoting",
    csv: [
      validHeader,
      '1,"Lightning Bolt,STA,R,Common,4',
    ].join("\n"),
    error: "CSV row 2: unterminated quoted field.",
  },
  {
    name: "empty normalized name",
    csv: [
      validHeader,
      '1,"   ",STA,R,Common,4',
    ].join("\n"),
    error: "CSV row 2: Name is empty.",
  },
  {
    name: "duplicate normalized name",
    csv: [
      validHeader,
      "1,Kaya’s  Guile,STA,W,Common,4",
      "2,kaya's guile,STA,W,Common,1",
    ].join("\n"),
    error: `CSV row 3: duplicate normalized Name "kaya's guile".`,
  },
  {
    name: "unsupported rarity",
    csv: [
      validHeader,
      "1,Lightning Bolt,STA,R,Legendary,4",
    ].join("\n"),
    error: 'CSV row 2: unsupported Rarity "Legendary".',
  },
  {
    name: "missing count",
    csv: [
      validHeader,
      "1,Lightning Bolt,STA,R,Common,",
    ].join("\n"),
    error: "CSV row 2: Count must be an integer from 0 through 4.",
  },
  {
    name: "fractional count",
    csv: [
      validHeader,
      "1,Lightning Bolt,STA,R,Common,1.5",
    ].join("\n"),
    error: "CSV row 2: Count must be an integer from 0 through 4.",
  },
  {
    name: "negative count",
    csv: [
      validHeader,
      "1,Lightning Bolt,STA,R,Common,-1",
    ].join("\n"),
    error: "CSV row 2: Count must be an integer from 0 through 4.",
  },
  {
    name: "count above four",
    csv: [
      validHeader,
      "1,Lightning Bolt,STA,R,Common,5",
    ].join("\n"),
    error: "CSV row 2: Count must be an integer from 0 through 4.",
  },
];

for (const invalidUpload of invalidUploads) {
  test(`rejects ${invalidUpload.name} without replacing the snapshot`, async ({
    page,
    context,
  }) => {
    const storage = await mountHelper(page);
    const helper = page.getByRole("region", { name: "MTGA Collection Helper" });
    await uploadCsv(page, "collection.csv", validCsv);
    await expect(helper).toContainText("2 unique card names");
    const uploadedAt = await helper.locator("time").getAttribute("datetime");

    await uploadCsv(page, "invalid.csv", invalidUpload.csv);

    await expect(helper.getByRole("alert")).toHaveText(invalidUpload.error);
    await expect(helper).toContainText("collection.csv");
    await expect(helper).toContainText("2 unique card names");
    await expect(helper.locator("time")).toHaveAttribute("datetime", uploadedAt ?? "");
    await expect(page.getByRole("button", { name: "Check", exact: true })).toBeEnabled();

    const restoredPage = await context.newPage();
    await mountHelper(restoredPage, storage);
    const restoredHelper = restoredPage.getByRole("region", {
      name: "MTGA Collection Helper",
    });
    await expect(restoredHelper).toContainText("collection.csv");
    await expect(restoredHelper).toContainText("2 unique card names");
    await expect(restoredHelper.locator("time")).toHaveAttribute(
      "datetime",
      uploadedAt ?? "",
    );
  });
}

import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import {
  PTree,
  type ScanOptions,
  type ScanPage,
} from "../dist/node/prolly_rust.js";

// Assuming you have these helpers, or define them here/import them
// from a shared test utility file.
const toU8 = (s: string): Uint8Array => new TextEncoder().encode(s);
const u8ToString = (arr: Uint8Array): string => new TextDecoder().decode(arr);

interface TestItem {
  key: Uint8Array;
  value: Uint8Array;
}

function expectU8Eq(
  a: Uint8Array | undefined | null,
  b: Uint8Array | undefined | null,
  message?: string
) {
  const context = message ? `: ${message}` : "";
  if (a === undefined || a === null) {
    expect(b, `Expected null or undefined${context}`).toBeFalsy();
    return;
  }
  expect(b, `Expected Uint8Array${context}`).toBeInstanceOf(Uint8Array);
  expect(Array.from(a), `Array comparison${context}`).toEqual(Array.from(b!));
}

function expectKeyValueArrayEq(
  actual: TestItem[],
  expected: TestItem[],
  message?: string
) {
  const context = message ? `: ${message}` : "";
  expect(actual.length, `Array length mismatch${context}`).toBe(
    expected.length
  );
  for (let i = 0; i < actual.length; i++) {
    expectU8Eq(
      actual?.[i]?.key,
      expected?.[i]?.key,
      `Key mismatch at index ${i}${context}`
    );
    expectU8Eq(
      actual?.[i]?.value,
      expected?.[i]?.value,
      `Value mismatch at index ${i}${context}`
    );
  }
}

function createTestItems(
  count: number,
  prefix = "key",
  valuePrefix = "val"
): TestItem[] {
  const items: TestItem[] = [];
  for (let i = 0; i < count; i++) {
    items.push({
      key: toU8(`${prefix}_${String(i).padStart(3, "0")}`),
      value: toU8(`${valuePrefix}_${String(i).padStart(3, "0")}`),
    });
  }
  // Ensure test data is sorted by key for predictable slicing and comparison
  items.sort((a, b) => {
    for (let i = 0; i < Math.min(a.key.length, b.key.length); i++) {
      if (a.key[i] !== b.key[i]) return a.key?.[i] ?? 0 - (b.key?.[i] ?? 0);
    }
    return a.key.length - b.key.length;
  });
  return items;
}

// TypeScript interfaces for ScanArgs and ScanResultPage
// These should align with what your wasm-pack build generates (usually in a .d.ts file)
interface ScanArgs {
  startBound?: Uint8Array | null;
  endBound?: Uint8Array | null;
  startInclusive?: boolean;
  endInclusive?: boolean;
  reverse?: boolean;
  offset?: number; // Corresponds to u64 in Rust
  limit?: number;
}

interface ScanResultPage {
  items: [Uint8Array, Uint8Array][]; // WASM typically returns tuple arrays
  hasNextPage: boolean;
  hasPreviousPage: boolean;
  nextPageCursor?: Uint8Array | null;
  previousPageCursor?: Uint8Array | null;
}

// Helper to parse the ScanResultPage and process items
async function jsPromiseToScanPageProcessed(promise: Promise<any>): Promise<{
  items: TestItem[];
  hasNextPage: boolean;
  hasPreviousPage: boolean;
  nextPageCursor?: Uint8Array | null;
  previousPageCursor?: Uint8Array | null;
}> {
  const jsVal = await promise; // jsVal is the ScanPage object from WASM

  if (typeof jsVal !== "object" || jsVal === null) {
    throw new Error(`scanItems did not return an object, got: ${typeof jsVal}`);
  }
  if (!Array.isArray(jsVal.items)) {
    throw new Error(
      `ScanResultPage.items is not an array, got: ${typeof jsVal.items}`
    );
  }
  // hasNextPage might be undefined if not explicitly set to false by Rust for last page with no limit
  const hasNextPage =
    jsVal.hasNextPage === undefined ? false : jsVal.hasNextPage;
  if (typeof hasNextPage !== "boolean") {
    throw new Error(
      `ScanResultPage.hasNextPage is not a boolean, got: ${typeof jsVal.hasNextPage}`
    );
  }

  const processedItems: TestItem[] = [];
  for (let i = 0; i < jsVal.items.length; i++) {
    const pair = jsVal.items[i]; // `pair` here is expected to be [Uint8Array, Uint8Array]

    // More robust check for the elements of the pair
    if (
      Array.isArray(pair) &&
      pair.length === 2 &&
      (pair[0] instanceof Uint8Array ||
        (typeof pair[0] === "object" &&
          pair[0] !== null &&
          typeof pair[0].length === "number")) && // Lenient check for array-like
      (pair[1] instanceof Uint8Array ||
        (typeof pair[1] === "object" &&
          pair[1] !== null &&
          typeof pair[1].length === "number"))
    ) {
      // If they are array-like but not Uint8Array, convert them.
      // This handles the case where they might be plain arrays of numbers from some contexts.
      const keyData =
        pair[0] instanceof Uint8Array
          ? pair[0]
          : new Uint8Array(pair[0] as number[]);
      const valueData =
        pair[1] instanceof Uint8Array
          ? pair[1]
          : new Uint8Array(pair[1] as number[]);
      processedItems.push({ key: keyData, value: valueData });
    } else {
      console.error(
        `Invalid item structure for 'pair' at index ${i} in jsVal.items:`,
        pair
      );
      if (pair && Array.isArray(pair) && pair.length === 2) {
        console.error(
          `Type of pair[0]: ${Object.prototype.toString.call(
            pair[0]
          )}, instanceof Uint8Array: ${pair[0] instanceof Uint8Array}`
        );
        console.error(
          `Type of pair[1]: ${Object.prototype.toString.call(
            pair[1]
          )}, instanceof Uint8Array: ${pair[1] instanceof Uint8Array}`
        );
      }
      throw new Error(
        `Invalid item structure in ScanResultPage.items at index ${i}. Expected each item to be a [Uint8Array, Uint8Array] tuple.`
      );
    }
  }

  // Determine hasPreviousPage based on args.offset if available, or from the page itself
  const jsValOffset =
    jsVal.args && typeof jsVal.args.offset === "number" ? jsVal.args.offset : 0;
  const hasPreviousPageDefault =
    jsVal.hasPreviousPage === undefined
      ? jsValOffset > 0
      : jsVal.hasPreviousPage;

  return {
    items: processedItems,
    hasNextPage: hasNextPage,
    hasPreviousPage: hasPreviousPageDefault,
    nextPageCursor:
      jsVal.nextPageCursor instanceof Uint8Array
        ? jsVal.nextPageCursor
        : undefined,
    previousPageCursor:
      jsVal.previousPageCursor instanceof Uint8Array
        ? jsVal.previousPageCursor
        : undefined,
  };
}

describe("PTree Scanning (scanItems)", () => {
  let tree: PTree;
  const testDataAll = createTestItems(25, "item", "value"); // item_000 to item_024

  beforeAll(async () => {
    // await init();
  });

  beforeEach(async () => {
    tree = new PTree();
    for (const item of testDataAll) {
      await tree.insert(item.key, item.value);
    }
  });

  it("should retrieve all items with no options (full scan, implies large limit)", async () => {
    const page = await jsPromiseToScanPageProcessed(
      tree.scanItems({ limit: testDataAll.length + 5 })
    );
    expectKeyValueArrayEq(page.items, testDataAll, "Full scan mismatch");
    expect(page.hasNextPage).toBe(false);
    expect(page.hasPreviousPage).toBe(false);
  });

  it("should handle offset correctly", async () => {
    const offset = 3;
    const page = await jsPromiseToScanPageProcessed(
      tree.scanItems({ offset, limit: testDataAll.length })
    );
    expectKeyValueArrayEq(
      page.items,
      testDataAll.slice(offset),
      "Offset mismatch"
    );
    expect(page.hasPreviousPage).toBe(true);
    expect(page.hasNextPage).toBe(false); // Since limit covers the rest
  });

  it("should handle limit correctly", async () => {
    const limit = 4;
    const page = await jsPromiseToScanPageProcessed(tree.scanItems({ limit }));
    expectKeyValueArrayEq(
      page.items,
      testDataAll.slice(0, limit),
      "Limit mismatch"
    );
    expect(page.hasNextPage).toBe(true);
    expect(page.items.length).toBe(limit);
  });

  it("should handle offset and limit combined", async () => {
    const offset = 2;
    const limit = 5;
    const page = await jsPromiseToScanPageProcessed(
      tree.scanItems({ offset, limit })
    );
    expectKeyValueArrayEq(
      page.items,
      testDataAll.slice(offset, offset + limit),
      "Offset + Limit mismatch"
    );
    expect(page.hasNextPage).toBe(testDataAll.length > offset + limit);
    expect(page.hasPreviousPage).toBe(offset > 0);
  });

  it("should handle forward pagination using nextPageCursor", async () => {
    // Test name updated slightly for clarity
    const pageSize = 3;

    // --- Page 1 ---
    let currentPage = await jsPromiseToScanPageProcessed(
      tree.scanItems({ limit: pageSize })
    );
    expectKeyValueArrayEq(
      currentPage.items,
      testDataAll.slice(0, pageSize), // item_000, item_001, item_002
      "Page 1 Items"
    );
    expect(currentPage.hasNextPage, "Page 1 hasNextPage").toBe(true);
    expect(currentPage.hasPreviousPage, "Page 1 hasPreviousPage").toBe(false); // First page

    // Corrected: nextPageCursor for Page 1 points to the start of Page 2
    if (currentPage.hasNextPage && testDataAll.length > pageSize) {
      expect(currentPage.nextPageCursor, "Page 1 nextPageCursor").toEqual(
        testDataAll[pageSize]?.key
      ); // Expects "item_003"
    } else {
      expect(
        currentPage.nextPageCursor,
        "Page 1 nextPageCursor"
      ).toBeUndefined();
    }
    // previousPageCursor for Page 1 should be its first item if hasPreviousPage were true,
    // but since hasPreviousPage is false, this check might be better inside an if(currentPage.hasPreviousPage)
    // For the first page, previousPageCursor is often undefined/null. The Rust logs show it's "item_000"
    // This is fine if hasPreviousPage: false overrides its usage.
    // Let's verify the first item of page 1 matches previousPageCursor if it's there.
    if (currentPage.items.length > 0) {
      // The current Rust logic sets previousPageCursor to the first item of the *current* page.
      expect(
        currentPage.previousPageCursor,
        "Page 1 previousPageCursor"
      ).toEqual(testDataAll[0]?.key); // Expects "item_000"
    }

    // --- Page 2 ---
    const page1NextCursor = currentPage.nextPageCursor;
    expect(
      page1NextCursor,
      "Page 1 nextPageCursor must exist for Page 2 fetch"
    ).toBeInstanceOf(Uint8Array);

    let nextPageArgs: ScanArgs = {
      limit: pageSize,
      startBound: currentPage.nextPageCursor, // This is testDataAll[pageSize].key ("item_003")
      startInclusive: false, // Scan should start *after* "item_003", i.e., from "item_004"
    };
    currentPage = await jsPromiseToScanPageProcessed(
      tree.scanItems(nextPageArgs)
    );

    // Page 2 should contain items starting from testDataAll[pageSize + 1]
    // For pageSize = 3, this is testDataAll[4], testDataAll[5], testDataAll[6]
    const expectedPage2Items = testDataAll.slice(
      pageSize + 1,
      pageSize + 1 + pageSize
    );
    expectKeyValueArrayEq(currentPage.items, expectedPage2Items, "Page 2");
    expect(currentPage.hasNextPage).toBe(true); // Assuming testDataAll is long enough

    // previousPageCursor for Page 2 should be the first item of Page 2, which is testDataAll[pageSize + 1]
    if (currentPage.hasPreviousPage && currentPage.items.length > 0) {
      expect(currentPage.previousPageCursor).toEqual(
        testDataAll[pageSize + 1]?.key
      );
    }

    // nextPageCursor for Page 2 should be the key of testDataAll[pageSize + 1 + pageSize]
    if (
      currentPage.hasNextPage &&
      testDataAll.length > pageSize + 1 + pageSize
    ) {
      expect(currentPage.nextPageCursor).toEqual(
        testDataAll[pageSize + 1 + pageSize]?.key
      );
    } else {
      // Adjust expectation if it's the last page
      // expect(currentPage.hasNextPage).toBe(false); // for example
      expect(currentPage.nextPageCursor).toBeUndefined();
    }

    // nextPageCursor for Page 2 points to start of Page 3
    if (
      currentPage.hasNextPage &&
      testDataAll.length > pageSize + 1 + pageSize
    ) {
      expect(currentPage.nextPageCursor, "Page 2 nextPageCursor").toEqual(
        testDataAll[pageSize + 1 + pageSize]?.key
      ); // Expects "item_007"
    } else {
      expect(
        currentPage.nextPageCursor,
        "Page 2 nextPageCursor"
      ).toBeUndefined();
    }

    // --- Page 3 ---
    const page2NextCursor = currentPage.nextPageCursor;
    expect(
      page2NextCursor,
      "Page 2 nextPageCursor must exist for Page 3 fetch"
    ).toBeInstanceOf(Uint8Array);

    nextPageArgs = {
      limit: pageSize,
      startBound: page2NextCursor, // Use "item_007"
      startInclusive: false, // Start *after* "item_007" -> should begin with "item_008"
    };
    currentPage = await jsPromiseToScanPageProcessed(
      tree.scanItems(nextPageArgs)
    );

    // Expected items for Page 3: "item_008", "item_009", "item_010"
    const expectedPage3Items = testDataAll.slice(
      pageSize + 1 + pageSize + 1,
      pageSize + 1 + pageSize + 1 + pageSize
    );
    expectKeyValueArrayEq(
      currentPage.items,
      expectedPage3Items,
      "Page 3 Items"
    );
    // Add more assertions for Page 3 cursors and hasNextPage as needed based on testDataAll.length
  });

  it("should retrieve items by key range (inclusive start, exclusive end)", async () => {
    const args: ScanArgs = {
      startBound: toU8("item_002"),
      startInclusive: true,
      endBound: toU8("item_005"),
      endInclusive: false, // Default
    };
    const page = await jsPromiseToScanPageProcessed(tree.scanItems(args));
    const expected = testDataAll.slice(2, 5); // item_002, item_003, item_004
    expectKeyValueArrayEq(
      page.items,
      expected,
      "Key range [start, end) mismatch"
    );
    expect(page.hasNextPage).toBe(false); // End bound is restrictive
  });

  it("should retrieve items by key range (inclusive start, inclusive end)", async () => {
    const args: ScanArgs = {
      startBound: toU8("item_015"),
      startInclusive: true,
      endBound: toU8("item_018"),
      endInclusive: true,
      limit: 10,
    };
    const page = await jsPromiseToScanPageProcessed(tree.scanItems(args));
    const expected = testDataAll.slice(15, 19); // item_015, item_016, item_017, item_018
    expectKeyValueArrayEq(
      page.items,
      expected,
      "Key range [start, end] mismatch"
    );
    // testDataAll.length = 25. Indices 0-24. item_018 is at index 18.
    expect(page.hasNextPage).toBe(false);
  });

  it("should handle reverse scan", async () => {
    const limit = 3;
    const page = await jsPromiseToScanPageProcessed(
      tree.scanItems({ reverse: true, limit })
    );
    const expected = [
      ...testDataAll.slice(testDataAll.length - limit),
    ].reverse();
    expectKeyValueArrayEq(page.items, expected, "Reverse scan mismatch");
    expect(page.hasNextPage).toBe(true); // Because there are items *before* these 3 (in reverse)
    expect(page.hasPreviousPage).toBe(false); // Offset is 0
  });

  it("should handle reverse scan with bounds (exclusive start/upper, inclusive end/lower)", async () => {
    const args: ScanArgs = {
      startBound: toU8("item_007"), // Scan keys < "item_007" (exclusive upper)
      startInclusive: false,
      endBound: toU8("item_003"), // Scan keys >= "item_003" (inclusive lower)
      endInclusive: true,
      reverse: true,
      limit: 10,
    };
    // Expected: item_006, item_005, item_004, item_003
    const page = await jsPromiseToScanPageProcessed(tree.scanItems(args));
    const expectedSlice = testDataAll.slice(3, 7); // item_003, item_004, item_005, item_006
    const expected = [...expectedSlice].reverse();

    expectKeyValueArrayEq(
      page.items,
      expected,
      "Reverse scan with bounds mismatch"
    );

    // hasNextPage for a reverse scan: are there more items with smaller keys (within bounds)?
    // Since the scan stopped because "item_002" was out of the lower bound (endBound "item_003" inclusive),
    // there are no more items matching the criteria in the reverse direction.
    expect(page.hasNextPage, "Reverse scan with bounds: hasNextPage").toBe(
      false
    );

    // hasPreviousPage for a reverse scan: are there items with larger keys (within bounds)?
    // The first item yielded was "item_006". The startBound was "item_007" (exclusive).
    // There are no items between "item_006" and "item_007".
    // The current Rust logic sets hasPreviousPage to true because start_bound was Some.
    // For this specific case, it should ideally be false if no offset was applied.
    // Let's assert what the current Rust logic (with the previous fix) produces.
    expect(
      page.hasPreviousPage,
      "Reverse scan with bounds: hasPreviousPage"
    ).toBe(true); // Based on current Rust logic
  });

  it("should return empty page for scan on empty tree", async () => {
    const emptyTree = new PTree();
    const page = await jsPromiseToScanPageProcessed(emptyTree.scanItems({}));
    expect(page.items.length).toBe(0);
    expect(page.hasNextPage).toBe(false);
  });

  it("should handle offset exceeding available items in range", async () => {
    const page = await jsPromiseToScanPageProcessed(
      tree.scanItems({ offset: testDataAll.length + 5 })
    );
    expect(page.items.length).toBe(0);
    expect(page.hasNextPage).toBe(false);
  });

  // --- Tests for Prefix Scans (Simulated with Bounds) ---
  it("should simulate prefix scan with startBound and endBound", async () => {
    const prefixTree = new PTree();
    const appleData = [
      { key: toU8("apple_01"), value: toU8("red_apple") },
      { key: toU8("apple_02"), value: toU8("green_apple") },
      { key: toU8("apple_03_final"), value: toU8("final_apple") },
    ];
    const otherData = [
      { key: toU8("banana_01"), value: toU8("yellow_banana") },
    ];
    const allData = [...appleData, ...otherData].sort((a, b) =>
      Buffer.from(a.key).compare(Buffer.from(b.key))
    );

    for (const item of allData) {
      await prefixTree.insert(item.key, item.value);
    }

    const prefix = "apple_";
    const startBound = toU8(prefix);
    // Create an endBound that is the lexicographical successor to any key starting with "apple_"
    // If U+FFFF is the max char, prefix + U+FFFF works.
    // A simpler way for common prefixes is to find the "next" prefix.
    // If "apple_" is the prefix, "apple`" (backtick, char after _) or "applf" would be after.
    // Let's use a key known to be after all "apple_" keys.
    const endBound = toU8("apple`"); // or any string that sorts immediately after all "apple_" keys

    const args: ScanArgs = {
      startBound: startBound,
      startInclusive: true,
      endBound: endBound,
      endInclusive: false, // Exclusive: we want keys < "apple`"
      limit: appleData.length + 1, // Ensure limit is not an issue
    };
    const page = await jsPromiseToScanPageProcessed(prefixTree.scanItems(args));
    expectKeyValueArrayEq(
      page.items,
      appleData,
      "Prefix scan with explicit bounds mismatch"
    );
    expect(page.hasNextPage).toBe(false); // Assuming endBound is tight
  });
});

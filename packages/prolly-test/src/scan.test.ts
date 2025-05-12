import { describe, it, expect, beforeAll, beforeEach } from "vitest";

import init, {
  WasmProllyTree,
  WasmProllyTreeCursor,
  type ScanArgs,
} from "prolly-wasm";
import {
  expectKeyValueArrayEq,
  jsPromiseToKeyValueArray,
  toU8,
  u8ToString,
} from "./lib/utils";
async function jsPromiseToScanPage(
  promise: Promise<any>
): Promise<ScanResultPage> {
  const jsVal = await promise;
  if (
    typeof jsVal !== "object" ||
    jsVal === null ||
    !Array.isArray(jsVal.items) ||
    typeof jsVal.hasNextPage !== "boolean"
  ) {
    console.error("Raw jsVal from promise:", jsVal);
    throw new Error(
      "scanItems did not return a valid ScanResultPage object structure"
    );
  }
  const processedItems: { key: Uint8Array; value: Uint8Array }[] = [];
  for (const pair of jsVal.items) {
    if (
      Array.isArray(pair) &&
      pair.length === 2 &&
      pair[0] instanceof Uint8Array &&
      pair[1] instanceof Uint8Array
    ) {
      processedItems.push({ key: pair[0], value: pair[1] });
    } else {
      throw new Error(
        "Invalid item structure in ScanResultPage.items. Expected [Uint8Array, Uint8Array]"
      );
    }
  }
  return {
    items: processedItems,
    hasNextPage: jsVal.hasNextPage,
    hasPreviousPage:
      jsVal.hasPreviousPage === undefined
        ? jsVal.offset > 0
        : jsVal.hasPreviousPage, // Handle if hasPreviousPage is not always sent
    nextPageCursor:
      jsVal.nextPageCursor instanceof Uint8Array ? jsVal.nextPageCursor : null,
    previousPageCursor:
      jsVal.previousPageCursor instanceof Uint8Array
        ? jsVal.previousPageCursor
        : null,
  };
}

function createTestItems(
  count: number,
  prefix = "key",
  valuePrefix = "val"
): { key: Uint8Array; value: Uint8Array }[] {
  const items: { key: Uint8Array; value: Uint8Array }[] = [];
  for (let i = 0; i < count; i++) {
    items.push({
      key: toU8(`${prefix}_${String(i).padStart(3, "0")}`),
      value: toU8(`${valuePrefix}_${String(i).padStart(3, "0")}`),
    });
  }
  items.sort((a, b) => {
    // Ensure test data is sorted by key for predictable slicing
    for (let i = 0; i < Math.min(a.key.length, b.key.length); i++) {
      if (a.key[i] !== b.key[i]) return a.key[i] - b.key[i];
    }
    return a.key.length - b.key.length;
  });
  return items;
}

describe("WasmProllyTree Scanning (scanItems)", () => {
  let tree: WasmProllyTree;
  const testData = createTestItems(20, "item", "value"); // item_000 to item_019

  beforeAll(async () => {
    await init(); // Make sure WASM is initialized
  });

  beforeEach(async () => {
    tree = new WasmProllyTree();
    for (const item of testData) {
      await tree.insert(item.key, item.value);
    }
    await tree.commit();
  });

  it("should retrieve all items with no options (full scan)", async () => {
    const page = await jsPromiseToScanPage(
      tree.scanItems({ limit: testData.length + 5 })
    ); // Provide a limit larger than data
    expectKeyValueArrayEq(page.items, testData, "Full scan mismatch");
    expect(page.hasNextPage).toBe(false);
    expect(page.hasPreviousPage).toBe(false); // Assuming offset 0
  });

  it("should handle offset correctly", async () => {
    const args: ScanArgs = { offset: 3, limit: testData.length }; // Get all after offset
    const page = await jsPromiseToScanPage(tree.scanItems(args));
    expectKeyValueArrayEq(page.items, testData.slice(3), "Offset mismatch");
    expect(page.hasPreviousPage).toBe(true);
  });

  it("should handle limit correctly", async () => {
    const args: ScanArgs = { limit: 4 };
    const page = await jsPromiseToScanPage(tree.scanItems(args));
    expectKeyValueArrayEq(page.items, testData.slice(0, 4), "Limit mismatch");
    expect(page.hasNextPage).toBe(true);
    expect(page.items.length).toBe(4);
  });

  it("should handle offset and limit combined", async () => {
    const args: ScanArgs = { offset: 2, limit: 5 };
    const page = await jsPromiseToScanPage(tree.scanItems(args));
    expectKeyValueArrayEq(
      page.items,
      testData.slice(2, 2 + 5),
      "Offset + Limit mismatch"
    );
    expect(page.hasNextPage).toBe(true); // 2 + 5 = 7, testData has 20 items
    expect(page.hasPreviousPage).toBe(true);
  });

  it("should handle forward pagination using nextPageCursor", async () => {
    const pageSize = 3;
    let currentPage = await jsPromiseToScanPage(
      tree.scanItems({ limit: pageSize })
    );
    expectKeyValueArrayEq(currentPage.items, testData.slice(0, pageSize));
    expect(currentPage.hasNextPage).toBe(true);
    expect(currentPage.nextPageCursor).not.toBeNull();

    // Fetch second page
    let nextPageArgs: ScanArgs = {
      limit: pageSize,
      startBound: currentPage.nextPageCursor,
      startInclusive: false,
    };
    currentPage = await jsPromiseToScanPage(tree.scanItems(nextPageArgs));
    expectKeyValueArrayEq(
      currentPage.items,
      testData.slice(pageSize, pageSize * 2)
    );
    expect(currentPage.hasNextPage).toBe(true);
    expect(currentPage.previousPageCursor).toEqual(testData[pageSize].key); // First key of this page

    // Fetch third page
    nextPageArgs = {
      limit: pageSize,
      startBound: currentPage.nextPageCursor,
      startInclusive: false,
    };
    currentPage = await jsPromiseToScanPage(tree.scanItems(nextPageArgs));
    expectKeyValueArrayEq(
      currentPage.items,
      testData.slice(pageSize * 2, pageSize * 3)
    );
  });

  it("should retrieve items by key range (startBound, endBound, inclusive start, exclusive end)", async () => {
    const args: ScanArgs = {
      startBound: toU8("item_002"),
      startInclusive: true,
      endBound: toU8("item_005"), // Exclusive end by default for ScanArgs
      endInclusive: false,
    };
    const page = await jsPromiseToScanPage(tree.scanItems(args));
    // Expected: item_002, item_003, item_004
    const expected = testData.slice(2, 5);
    expectKeyValueArrayEq(page.items, expected, "Key range query mismatch");
    expect(page.hasNextPage).toBe(false); // Assuming limit is not hit and endBound is restrictive
  });

  it("should retrieve items by key range (inclusive start, inclusive end)", async () => {
    const args: ScanArgs = {
      startBound: toU8("item_015"),
      startInclusive: true,
      endBound: toU8("item_018"),
      endInclusive: true,
      limit: 10, // Ensure limit is not the reason for stopping
    };
    const page = await jsPromiseToScanPage(tree.scanItems(args));
    // Expected: item_015, item_016, item_017, item_018
    const expected = testData.slice(15, 19);
    expectKeyValueArrayEq(
      page.items,
      expected,
      "Inclusive end key range query mismatch"
    );
    expect(page.hasNextPage).toBe(testData.length > 19);
  });

  it("should handle reverse scan", async () => {
    const args: ScanArgs = { reverse: true, limit: 3 };
    const page = await jsPromiseToScanPage(tree.scanItems(args));
    const expected = [...testData.slice(testData.length - 3)].reverse(); // Last 3 items, reversed
    expectKeyValueArrayEq(page.items, expected, "Reverse scan mismatch");
    expect(page.hasNextPage).toBe(true); // More items before these three
  });

  it("should handle reverse scan with bounds", async () => {
    const args: ScanArgs = {
      startBound: toU8("item_007"), // In reverse, this is the "upper" bound (exclusive by default if endInclusive is false for it)
      endBound: toU8("item_003"), // In reverse, this is the "lower" bound (inclusive by default if startInclusive is true for it)
      startInclusive: true, // for endBound in reverse context
      endInclusive: false, // for startBound in reverse context
      reverse: true,
      limit: 10,
    };
    // Scan from item_007 down to (but not including) item_003
    // Expected: item_007, item_006, item_005, item_004
    const page = await jsPromiseToScanPage(tree.scanItems(args));
    const expectedSlice = testData.slice(4, 8); // item_004 to item_007
    const expected = [...expectedSlice].reverse();
    expectKeyValueArrayEq(
      page.items,
      expected,
      "Reverse scan with bounds mismatch"
    );
  });

  it("should return empty page for scan on empty tree", async () => {
    const emptyTree = new WasmProllyTree();
    await emptyTree.commit();
    const page = await jsPromiseToScanPage(emptyTree.scanItems({}));
    expect(page.items.length).toBe(0);
    expect(page.hasNextPage).toBe(false);
  });

  it("should handle offset exceeding available items in range", async () => {
    const args: ScanArgs = { offset: testData.length + 5 };
    const page = await jsPromiseToScanPage(tree.scanItems(args));
    expect(page.items.length).toBe(0);
    expect(page.hasNextPage).toBe(false);
  });

  it("should handle limit exceeding available items after offset in range", async () => {
    const offset = testData.length - 2; // Last 2 items available
    const args: ScanArgs = { offset, limit: 5 };
    const page = await jsPromiseToScanPage(tree.scanItems(args));
    expectKeyValueArrayEq(
      page.items,
      testData.slice(offset),
      "Limit exceeding available mismatch"
    );
    expect(page.hasNextPage).toBe(false);
  });

  // ---- Tests for Prefix Scans (Simulated with Bounds) ----
  it("should simulate prefix scan with startBound and iteration check", async () => {
    const prefixTree = new WasmProllyTree();
    const appleItems = [
      { key: toU8("apple_1"), value: toU8("red") },
      { key: toU8("apple_2"), value: toU8("green") },
      { key: toU8("apple_3"), value: toU8("mixed") },
    ];
    const otherItem = { key: toU8("banana_1"), value: toU8("yellow") };
    for (const item of [...appleItems, otherItem].sort((a, b) =>
      Buffer.from(a.key).compare(Buffer.from(b.key))
    )) {
      await prefixTree.insert(item.key, item.value);
    }
    await prefixTree.commit();

    const prefix = "apple_";
    const prefixBytes = toU8(prefix);
    const args: ScanArgs = { startBound: prefixBytes, startInclusive: true };

    const page = await jsPromiseToScanPage(prefixTree.scanItems(args));

    // Client-side filter for prefix because scanItems only guarantees starting at/after prefixBytes
    const filteredItems = page.items.filter((item) =>
      u8ToString(item.key).startsWith(prefix)
    );

    expectKeyValueArrayEq(
      filteredItems,
      appleItems,
      "Simulated prefix scan mismatch"
    );
  });

  it("should simulate prefix scan with startBound and endBound", async () => {
    const prefixTree = new WasmProllyTree();
    const appleItems = [
      { key: toU8("apple_01"), value: toU8("red") },
      { key: toU8("apple_02"), value: toU8("green") },
    ];
    const otherItems = [
      { key: toU8("apricot_01"), value: toU8("orange") },
      { key: toU8("banana_01"), value: toU8("yellow") },
    ];
    for (const item of [...appleItems, ...otherItems].sort((a, b) =>
      Buffer.from(a.key).compare(Buffer.from(b.key))
    )) {
      await prefixTree.insert(item.key, item.value);
    }
    await prefixTree.commit();

    const prefix = "apple_";
    const startBound = toU8(prefix);
    // Create an endBound that is the next possible string after the prefix
    // For "apple_", the next string lexicographically is "apple`" (if '`' is char after '_')
    // Or more robustly, find the string that is "apple" + char_after_underscore
    // For simplicity, if keys are somewhat predictable, "apple_" will be before "apricot" or "applea"
    // A common technique for exclusive end bound for prefix P is P + 0xFF (or highest byte)
    // Or, the next known prefix: endBound = toU8("apricot_")
    // For this test, let's assume "applea" would be next different prefix.
    const endBound = toU8("applea"); // All keys starting "apple_" are < "applea"

    const args: ScanArgs = {
      startBound: startBound,
      startInclusive: true,
      endBound: endBound,
      endInclusive: false, // Exclusive end
    };
    const page = await jsPromiseToScanPage(prefixTree.scanItems(args));
    expectKeyValueArrayEq(
      page.items,
      appleItems,
      "Prefix scan with explicit bounds mismatch"
    );
  });
});

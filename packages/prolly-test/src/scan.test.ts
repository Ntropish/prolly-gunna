import { describe, it, expect, beforeAll, beforeEach } from "vitest";

import init, { WasmProllyTree, WasmProllyTreeCursor } from "prolly-wasm";
import {
  expectKeyValueArrayEq,
  jsPromiseToKeyValueArray,
  toU8,
} from "./lib/utils";

function createTestItems(
  count: number,
  prefix = "key",
  valuePrefix = "val"
): { key: Uint8Array; value: Uint8Array }[] {
  const items: { key: Uint8Array; value: Uint8Array }[] = [];
  for (let i = 0; i < count; i++) {
    items.push({
      key: toU8(`${prefix}_${String(i).padStart(3, "0")}`), // Changed k to key
      value: toU8(`${valuePrefix}_${String(i).padStart(3, "0")}`), // Changed v to value
    });
  }
  return items;
}

describe("WasmProllyTree Querying (queryItems / scanItems)", () => {
  let tree: WasmProllyTree;
  const testData = createTestItems(10, "item", "value"); // item_000 to item_009

  beforeAll(async () => {
    // Ensure init() is called if not already handled globally
    // await init();
  });

  beforeEach(async () => {
    tree = new WasmProllyTree();
    for (const item of testData) {
      await tree.insert(item.key, item.value);
    }
    await tree.commit(); // Ensure data is written
  });

  it("should retrieve all items with no options (implicit full scan)", async () => {
    const results = await jsPromiseToKeyValueArray(
      tree.queryItems(undefined, undefined, undefined, undefined, undefined)
    );
    expectKeyValueArrayEq(results, testData, "Full scan mismatch");
  });

  it("should handle offset correctly", async () => {
    const offset = 3;
    const results = await jsPromiseToKeyValueArray(
      tree.queryItems(undefined, undefined, undefined, offset, undefined)
    );
    expectKeyValueArrayEq(results, testData.slice(offset), "Offset mismatch");
  });

  it("should handle limit correctly", async () => {
    const limit = 4;
    const results = await jsPromiseToKeyValueArray(
      tree.queryItems(undefined, undefined, undefined, undefined, limit)
    );
    expectKeyValueArrayEq(results, testData.slice(0, limit), "Limit mismatch");
  });

  it("should handle offset and limit combined", async () => {
    const offset = 2;
    const limit = 5;
    const results = await jsPromiseToKeyValueArray(
      tree.queryItems(undefined, undefined, undefined, offset, limit)
    );
    expectKeyValueArrayEq(
      results,
      testData.slice(offset, offset + limit),
      "Offset + Limit mismatch"
    );
  });

  it("should retrieve items by key prefix", async () => {
    const prefixTree = new WasmProllyTree();
    await prefixTree.insert(toU8("apple_1"), toU8("red"));
    await prefixTree.insert(toU8("apple_2"), toU8("green"));
    await prefixTree.insert(toU8("banana_1"), toU8("yellow"));
    await prefixTree.insert(toU8("apple_3"), toU8("mixed"));
    await prefixTree.commit();

    const prefix = toU8("apple_");
    const results = await jsPromiseToKeyValueArray(
      prefixTree.queryItems(undefined, undefined, prefix, undefined, undefined)
    );
    const expected = [
      // Corrected here
      { key: toU8("apple_1"), value: toU8("red") },
      { key: toU8("apple_2"), value: toU8("green") },
      { key: toU8("apple_3"), value: toU8("mixed") },
    ];
    expectKeyValueArrayEq(results, expected, "Prefix query mismatch");
  });

  it("should retrieve items by key prefix with limit", async () => {
    const prefixTree = new WasmProllyTree();
    await prefixTree.insert(toU8("user_alpha_data"), toU8("alpha1"));
    await prefixTree.insert(toU8("user_beta_data"), toU8("beta1"));
    await prefixTree.insert(toU8("user_alpha_more"), toU8("alpha2"));
    await prefixTree.insert(toU8("user_gamma_data"), toU8("gamma1"));
    await prefixTree.commit();

    const prefix = toU8("user_alpha");
    const limit = 1;
    const results = await jsPromiseToKeyValueArray(
      prefixTree.queryItems(undefined, undefined, prefix, undefined, limit)
    );
    const expected = [{ key: toU8("user_alpha_data"), value: toU8("alpha1") }]; // Corrected here
    expectKeyValueArrayEq(
      results,
      expected,
      "Prefix query with limit mismatch"
    );
  });

  it("should retrieve items by key range (startKey and endKey)", async () => {
    // testData keys are item_000 to item_009
    const startKey = toU8("item_002");
    const endKey = toU8("item_005"); // Inclusive end
    const results = await jsPromiseToKeyValueArray(
      tree.queryItems(startKey, endKey, undefined, undefined, undefined)
    );
    // Expected: item_002, item_003, item_004, item_005
    const expected = testData.slice(2, 6);
    expectKeyValueArrayEq(results, expected, "Key range query mismatch");
  });

  it("should retrieve items by key range with offset and limit", async () => {
    const startKey = toU8("item_001");
    const endKey = toU8("item_007");
    const offset = 1;
    const limit = 3;
    // Range will be item_001 to item_007 (indices 1 to 7)
    // Effective sub-slice: testData.slice(1, 8) -> [item_001, ..., item_007]
    // Apply offset: skip item_001 -> starts from item_002
    // Apply limit: item_002, item_003, item_004
    const results = await jsPromiseToKeyValueArray(
      tree.queryItems(startKey, endKey, undefined, offset, limit)
    );
    const expected = testData.slice(1 + offset, 1 + offset + limit); // testData.slice(2, 5)
    expectKeyValueArrayEq(
      results,
      expected,
      "Key range with offset & limit mismatch"
    );
  });

  it("should return empty array for query on empty tree", async () => {
    const emptyTree = new WasmProllyTree();
    await emptyTree.commit();
    const results = await jsPromiseToKeyValueArray(
      emptyTree.queryItems(
        undefined,
        undefined,
        undefined,
        undefined,
        undefined
      )
    );
    expect(results.length).toBe(0);
  });

  it("should handle offset exceeding available items", async () => {
    const offset = testData.length + 5;
    const results = await jsPromiseToKeyValueArray(
      tree.queryItems(undefined, undefined, undefined, offset, undefined)
    );
    expect(results.length).toBe(0);
  });

  it("should handle limit exceeding available items after offset", async () => {
    const offset = 8; // testData[8], testData[9] remain
    const limit = 5; // Request 5, but only 2 available
    const results = await jsPromiseToKeyValueArray(
      tree.queryItems(undefined, undefined, undefined, offset, limit)
    );
    expectKeyValueArrayEq(
      results,
      testData.slice(offset),
      "Limit exceeding available mismatch"
    );
  });

  it("should return empty array if startKey is after all keys", async () => {
    const startKey = toU8("z_item"); // After all "item_xxx"
    const results = await jsPromiseToKeyValueArray(
      tree.queryItems(startKey, undefined, undefined, undefined, undefined)
    );
    expect(results.length).toBe(0);
  });

  it("should return empty array if endKey is before all keys (or before startKey)", async () => {
    const startKey = toU8("item_005");
    const endKey = toU8("item_001"); // endKey < startKey
    const results = await jsPromiseToKeyValueArray(
      tree.queryItems(startKey, endKey, undefined, undefined, undefined)
    );
    expect(results.length).toBe(0);
  });

  it("should correctly handle an open-ended range (only startKey)", async () => {
    const startKey = toU8("item_007");
    const results = await jsPromiseToKeyValueArray(
      tree.queryItems(startKey, undefined, undefined, undefined, undefined)
    );
    // Expected: item_007, item_008, item_009
    expectKeyValueArrayEq(
      results,
      testData.slice(7),
      "Open-ended range (startKey only) mismatch"
    );
  });

  it("should correctly handle an open-ended range (only endKey)", async () => {
    const endKey = toU8("item_002");
    const results = await jsPromiseToKeyValueArray(
      tree.queryItems(undefined, endKey, undefined, undefined, undefined)
    );
    // Expected: item_000, item_001, item_002
    expectKeyValueArrayEq(
      results,
      testData.slice(0, 3),
      "Open-ended range (endKey only) mismatch"
    );
  });

  it("should handle prefix query that yields no results", async () => {
    const prefix = toU8("non_existent_prefix_");
    const results = await jsPromiseToKeyValueArray(
      tree.queryItems(undefined, undefined, prefix, undefined, undefined)
    );
    expect(results.length).toBe(0);
  });
});

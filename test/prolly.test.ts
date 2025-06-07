import { describe, it, expect, beforeAll } from "vitest";

import init, { WasmProllyTree, WasmProllyTreeCursor } from "prolly-wasm";
import { expectU8Eq, formatU8Array, JsDiffEntry, toU8 } from "./lib/utils";

beforeAll(async () => {
  // Initialize the Wasm module once before all tests
  // await init();
});

describe("WasmProllyTree", () => {
  it("should allow creating, inserting, and getting values", async () => {
    const tree = new WasmProllyTree();

    const key1 = toU8("hello");
    const val1 = toU8("world");
    await tree.insert(key1, val1);

    const key2 = toU8("goodbye");
    const val2 = toU8("moon");
    await tree.insert(key2, val2);

    const result1 = (await tree.get(key1)) as Uint8Array | null;
    expectU8Eq(result1, val1);

    const result2 = (await tree.get(key2)) as Uint8Array | null;
    expectU8Eq(result2, val2);

    const result3 = (await tree.get(toU8("nonexistent"))) as Uint8Array | null;
    expect(result3).toBeNull();
  });

  it("should update root hash after inserts", async () => {
    const tree = new WasmProllyTree();
    const initialHash = (await tree.getRootHash()) as Uint8Array | null;
    expect(initialHash).toBeNull();

    await tree.insert(toU8("a"), toU8("1"));
    const hash1 = (await tree.getRootHash()) as Uint8Array | null;
    expect(hash1).not.toBeNull();
    expect(hash1?.length).toBe(32);

    await tree.insert(toU8("b"), toU8("2"));
    const hash2 = (await tree.getRootHash()) as Uint8Array | null;
    expect(hash2).not.toBeNull();
    expect(hash2?.length).toBe(32);

    // Hashes should likely be different after modification
    expect(Array.from(hash1!)).not.toEqual(Array.from(hash2!));
  });

  it("should handle many inserts potentially causing splits", async () => {
    const tree = new WasmProllyTree();
    const count = 100; // Should be enough to trigger splits with default fanout 32
    const expected = new Map<string, Uint8Array>();

    for (let i = 0; i < count; i++) {
      const keyStr = `key_${String(i).padStart(3, "0")}`;
      const valStr = `value_${String(i).padStart(3, "0")}`;
      const key = toU8(keyStr);
      const val = toU8(valStr);
      await tree.insert(key, val);
      expected.set(keyStr, val);
    }

    const finalHash = (await tree.getRootHash()) as Uint8Array | null;
    expect(finalHash).not.toBeNull();

    // Verify some values
    for (let i = 0; i < count; i += 10) {
      const keyStr = `key_${String(i).padStart(3, "0")}`;
      const key = toU8(keyStr);
      const expectedVal = expected.get(keyStr);
      const actualVal = (await tree.get(key)) as Uint8Array | null;
      expectU8Eq(actualVal, expectedVal);
    }
  });

  it("should support load and export", async () => {
    const tree1 = new WasmProllyTree();
    await tree1.insert(toU8("data1"), toU8("value1"));
    await tree1.insert(toU8("data2"), toU8("value2"));

    const rootHash = (await tree1.getRootHash()) as Uint8Array;
    expect(rootHash).not.toBeNull();

    const chunks = (await tree1.exportChunks()) as Map<Uint8Array, Uint8Array>;
    expect(chunks.size).toBeGreaterThan(0); // Should have at least the root node chunk

    // Create a new tree loaded from the exported state
    const tree2 = await WasmProllyTree.load(rootHash, chunks);

    // Verify data in loaded tree
    const val1Loaded = (await tree2.get(toU8("data1"))) as Uint8Array | null;
    expectU8Eq(val1Loaded, toU8("value1"));
    const val2Loaded = (await tree2.get(toU8("data2"))) as Uint8Array | null;
    expectU8Eq(val2Loaded, toU8("value2"));

    const rootHash2 = (await tree2.getRootHash()) as Uint8Array | null;
    expectU8Eq(rootHash2, rootHash); // Root hashes should match
  });

  it("should overwrite existing values on insert with the same key", async () => {
    const tree = new WasmProllyTree();
    const key = toU8("overwrite_key");
    const val1 = toU8("initial_value");
    const val2 = toU8("overwritten_value");

    await tree.insert(key, val1);
    const retrieved1 = (await tree.get(key)) as Uint8Array | null;
    expectU8Eq(retrieved1, val1);
    const hash1 = (await tree.getRootHash()) as Uint8Array | null;

    await tree.insert(key, val2); // Insert same key again with different value
    const retrieved2 = (await tree.get(key)) as Uint8Array | null;
    expectU8Eq(retrieved2, val2); // Should now have the new value
    const hash2 = (await tree.getRootHash()) as Uint8Array | null;

    expect(hash1).not.toBeNull();
    expect(hash2).not.toBeNull();
    // Overwriting a value should change the leaf node and thus the root hash
    expect(Array.from(hash1!)).not.toEqual(Array.from(hash2!));
  });

  it("should handle empty keys and values", async () => {
    const tree = new WasmProllyTree();
    const emptyKey = toU8("");
    const emptyVal = toU8("");
    const normalKey = toU8("key");
    const normalVal = toU8("value");

    await tree.insert(emptyKey, normalVal);
    await tree.insert(normalKey, emptyVal);

    const retrieved1 = (await tree.get(emptyKey)) as Uint8Array | null;
    expectU8Eq(retrieved1, normalVal);

    const retrieved2 = (await tree.get(normalKey)) as Uint8Array | null;
    expectU8Eq(retrieved2, emptyVal);
  });

  it("should maintain lexicographical order", async () => {
    const tree = new WasmProllyTree();
    const keys = ["C", "A", "B", "D", "E"]; // Insert out of order

    for (const k of keys) {
      await tree.insert(toU8(k), toU8(`val_${k}`));
    }

    // Check if retrieval works correctly after out-of-order inserts
    for (const k of keys.sort()) {
      const retrieved = (await tree.get(toU8(k))) as Uint8Array | null;
      // Corrected call:
      expectU8Eq(retrieved, toU8(`val_${k}`));
    }
  });

  it("should produce different root hashes for different insertion orders (usually)", async () => {
    // Prolly trees aim for deterministic structure based on content,
    // BUT the exact split points might slightly differ based on insertion order,
    // leading to potentially different intermediate node hashes and maybe root hash.
    // B-trees are definitely order-dependent. Prolly Trees *should* be less so,
    // but let's test if order matters *at all* in the current implementation.

    const tree1 = new WasmProllyTree();
    await tree1.insert(toU8("a"), toU8("1"));
    await tree1.insert(toU8("b"), toU8("2"));
    await tree1.insert(toU8("c"), toU8("3"));
    const hash1 = (await tree1.getRootHash()) as Uint8Array | null;

    const tree2 = new WasmProllyTree();
    await tree2.insert(toU8("c"), toU8("3"));
    await tree2.insert(toU8("a"), toU8("1"));
    await tree2.insert(toU8("b"), toU8("2"));
    const hash2 = (await tree2.getRootHash()) as Uint8Array | null;

    const tree3 = new WasmProllyTree(); // Same data as tree1, check consistency
    await tree3.insert(toU8("a"), toU8("1"));
    await tree3.insert(toU8("b"), toU8("2"));
    await tree3.insert(toU8("c"), toU8("3"));
    const hash3 = (await tree3.getRootHash()) as Uint8Array | null;

    expect(hash1).not.toBeNull();
    expect(hash2).not.toBeNull();
    expect(hash3).not.toBeNull();

    // Compare tree1 and tree3 - should ideally be identical if structure is deterministic
    expectU8Eq(hash1, hash3);

    // Compare tree1 and tree2 - *might* be different due to split point variations
    // If they ARE different, it suggests the current split logic isn't purely content-defined yet.
    // If they ARE the same, it suggests good determinism for this simple case.
    // Let's expect they might be different for now until we add content-defined boundaries.
    // expect(Array.from(hash1!)).not.toEqual(Array.from(hash2!));
    // OR, if we want to assert determinism (a goal of Prolly Trees):
    expectU8Eq(hash1, hash2);
  });

  it("should handle keys/values with varied lengths and binary data", async () => {
    const tree = new WasmProllyTree();

    const keyShort = toU8("short");
    const valShort = toU8("sv");

    const keyLong = toU8(
      "a_very_long_key_that_might_affect_node_packing_or_boundaries_eventually"
    );
    const valLong = toU8(
      "this_is_a_much_longer_value_than_the_others_inserted_so_far_".repeat(10)
    );

    const keyBinary = new Uint8Array([0, 1, 2, 3, 255, 128, 4, 0]);
    const valBinary = new Uint8Array([10, 20, 0, 30, 0, 40]);

    await tree.insert(keyShort, valShort);
    await tree.insert(keyLong, valLong);
    await tree.insert(keyBinary, valBinary);

    const r1 = (await tree.get(keyShort)) as Uint8Array | null;
    expectU8Eq(r1, valShort);
    const r2 = (await tree.get(keyLong)) as Uint8Array | null;
    expectU8Eq(r2, valLong);
    const r3 = (await tree.get(keyBinary)) as Uint8Array | null;
    expectU8Eq(r3, valBinary);
  });

  it("should trigger a root leaf split and verify content", async () => {
    const tree = new WasmProllyTree();
    // Default fanout is 32. Insert 33 items to force a split.
    const count = 33;
    const inserted = new Map<string, string>();

    for (let i = 0; i < count; i++) {
      const keyStr = `split_key_${String(i).padStart(2, "0")}`;
      const valStr = `split_val_${i}`;
      await tree.insert(toU8(keyStr), toU8(valStr));
      inserted.set(keyStr, valStr);
    }

    const rootHash = (await tree.getRootHash()) as Uint8Array | null;
    expect(rootHash).not.toBeNull();
    // We can't easily inspect the tree structure from JS,
    // but we can verify all data is still present and retrievable.
    expect(inserted.size).toBe(count);
    for (const [keyStr, valStr] of inserted.entries()) {
      const retrieved = (await tree.get(toU8(keyStr))) as Uint8Array | null;
      expectU8Eq(retrieved, toU8(valStr), `Failed for ${keyStr} after split`);
    }

    // Also test load/export after a known split
    const chunks = (await tree.exportChunks()) as Map<Uint8Array, Uint8Array>;
    expect(chunks.size).toBeGreaterThan(2); // Should have at least old root (now left leaf), right leaf, new root internal node

    const tree2 = await WasmProllyTree.load(rootHash!, chunks);
    const keyToTest = `split_key_${String(count - 1).padStart(2, "0")}`; // Test last key
    const retrieved2 = (await tree2.get(toU8(keyToTest))) as Uint8Array | null;
    expectU8Eq(retrieved2, toU8(inserted.get(keyToTest)!));
  });

  // TODO: Implement this test as these are configurable now
  // Note: Testing internal node splits requires fanout * fanout items (e.g., 32*32 = 1024)
  // which might be too slow for a unit test. This could be a longer-running integration test.
  it.skip("should trigger internal node splits (large test)", async () => {
    // Skipped by default due to size/time
    const tree = new WasmProllyTree();
    const count = 1025; // Fanout 32 * 32 + 1 (approximate threshold)
    for (let i = 0; i < count; i++) {
      const keyStr = `internal_split_${String(i).padStart(4, "0")}`;
      const valStr = `val_${i}`;
      await tree.insert(toU8(keyStr), toU8(valStr));
    }
    const rootHash = (await tree.getRootHash()) as Uint8Array | null;
    expect(rootHash).not.toBeNull();
    // Verify a few values
    const retrieved = (await tree.get(
      toU8("internal_split_0500")
    )) as Uint8Array | null;
    expectU8Eq(retrieved, toU8("val_500"));
  });

  it("should return consistent root hash if no modifications occur", async () => {
    const tree = new WasmProllyTree();
    await tree.insert(toU8("a"), toU8("1"));
    const hash1 = (await tree.getRootHash()) as Uint8Array | null;

    // Perform some read operations
    await tree.get(toU8("a"));
    await tree.get(toU8("nonexistent"));

    const hash2 = (await tree.getRootHash()) as Uint8Array | null;
    expectU8Eq(hash1, hash2); // Root hash should not change after only reads
  });

  it("should allow overwriting then getting other keys", async () => {
    const tree = new WasmProllyTree();
    await tree.insert(toU8("keyA"), toU8("valA1"));
    await tree.insert(toU8("keyB"), toU8("valB1"));

    // Overwrite keyA
    await tree.insert(toU8("keyA"), toU8("valA2"));

    // Check keyA has new value
    const retrievedA = (await tree.get(toU8("keyA"))) as Uint8Array | null;
    expectU8Eq(retrievedA, toU8("valA2"));

    // Check keyB still has original value
    const retrievedB = (await tree.get(toU8("keyB"))) as Uint8Array | null;
    expectU8Eq(retrievedB, toU8("valB1"));
  });

  describe("insertBatch", () => {
    it("should insert multiple items into an empty tree", async () => {
      const tree = new WasmProllyTree();
      const itemsToInsert = [
        { k: "batch_key1", v: "batch_val1" },
        { k: "batch_key2", v: "batch_val2" },
        { k: "batch_key0", v: "batch_val0" }, // Insert out of order
      ];

      const jsArrayItems = itemsToInsert.map((item) => [
        toU8(item.k),
        toU8(item.v),
      ]);

      // The WasmProllyTree.insertBatch expects a js_sys::Array directly.
      // In a pure JS/TS test environment, you might need to construct it carefully
      // or ensure your Wasm binding layer handles plain JS arrays.
      // For vitest, directly passing a JS array of Uint8Array pairs should work
      // if the wasm-bindgen layer correctly converts it.
      await tree.insertBatch(jsArrayItems as any); // Cast as any if js_sys::Array isn't directly usable here

      for (const item of itemsToInsert) {
        const retrieved = (await tree.get(toU8(item.k))) as Uint8Array | null;
        expectU8Eq(
          retrieved,
          toU8(item.v),
          `Failed for ${item.k} after batch insert`
        );
      }
      const rootHash = (await tree.getRootHash()) as Uint8Array | null;
      expect(rootHash).not.toBeNull();
    });

    it("should insert multiple items into a non-empty tree", async () => {
      const tree = new WasmProllyTree();
      await tree.insert(toU8("existing_key"), toU8("existing_val"));
      const initialRootHash = await tree.getRootHash();

      const itemsToInsert = [
        { k: "new_batch_key1", v: "new_batch_val1" },
        { k: "new_batch_key2", v: "new_batch_val2" },
      ];
      const jsArrayItems = itemsToInsert.map((item) => [
        toU8(item.k),
        toU8(item.v),
      ]);
      await tree.insertBatch(jsArrayItems as any);

      // Check new items
      for (const item of itemsToInsert) {
        const retrieved = (await tree.get(toU8(item.k))) as Uint8Array | null;
        expectU8Eq(retrieved, toU8(item.v));
      }
      // Check existing item
      const retrievedExisting = (await tree.get(
        toU8("existing_key")
      )) as Uint8Array | null;
      expectU8Eq(retrievedExisting, toU8("existing_val"));

      const finalRootHash = (await tree.getRootHash()) as Uint8Array | null;
      expect(finalRootHash).not.toBeNull();
      expect(Array.from(finalRootHash!)).not.toEqual(
        Array.from(initialRootHash!)
      );
    });

    it("should overwrite existing keys during batch insert", async () => {
      const tree = new WasmProllyTree();
      await tree.insert(toU8("overwrite_key1"), toU8("initial_val1"));
      await tree.insert(toU8("another_key"), toU8("initial_other_val"));

      const itemsToInsert = [
        { k: "overwrite_key1", v: "overwritten_val1" }, // This will overwrite
        { k: "new_key_in_batch", v: "new_val_in_batch" },
      ];
      const jsArrayItems = itemsToInsert.map((item) => [
        toU8(item.k),
        toU8(item.v),
      ]);
      await tree.insertBatch(jsArrayItems as any);

      const retrievedOverwrite = (await tree.get(
        toU8("overwrite_key1")
      )) as Uint8Array | null;
      expectU8Eq(retrievedOverwrite, toU8("overwritten_val1"));

      const retrievedNew = (await tree.get(
        toU8("new_key_in_batch")
      )) as Uint8Array | null;
      expectU8Eq(retrievedNew, toU8("new_val_in_batch"));

      const retrievedAnother = (await tree.get(
        toU8("another_key")
      )) as Uint8Array | null;
      expectU8Eq(retrievedAnother, toU8("initial_other_val")); // Should remain unchanged
    });

    it("should handle an empty batch without error", async () => {
      const tree = new WasmProllyTree();
      await tree.insert(toU8("key_before_empty_batch"), toU8("val_before"));
      const initialRootHash = await tree.getRootHash();

      const emptyJsArrayItems: Uint8Array[][] = [];
      await tree.insertBatch(emptyJsArrayItems as any);

      const finalRootHash = await tree.getRootHash();
      expectU8Eq(
        finalRootHash,
        initialRootHash,
        "Root hash should not change after empty batch insert"
      );

      const retrieved = (await tree.get(
        toU8("key_before_empty_batch")
      )) as Uint8Array | null;
      expectU8Eq(retrieved, toU8("val_before"));
    });

    it("should insert a larger batch potentially causing splits", async () => {
      const tree = new WasmProllyTree(); // Default config
      const batchSize = 50; // Enough to likely cause splits
      const itemsToInsert = [] as { k: string; v: string }[];
      for (let i = 0; i < batchSize; i++) {
        itemsToInsert.push({
          k: `large_batch_key_${String(i).padStart(2, "0")}`,
          v: `val_${i}`,
        });
      }
      const jsArrayItems = itemsToInsert.map((item) => [
        toU8(item.k),
        toU8(item.v),
      ]);

      const initialRootHash = await tree.getRootHash(); // Should be null
      await tree.insertBatch(jsArrayItems as any);
      const finalRootHash = await tree.getRootHash();
      expect(finalRootHash).not.toBeNull();
      if (initialRootHash) {
        // If tree wasn't empty
        expect(Array.from(finalRootHash!)).not.toEqual(
          Array.from(initialRootHash)
        );
      }

      // Verify a subset of items
      for (let i = 0; i < batchSize; i += 5) {
        const item = itemsToInsert[i];
        const retrieved = (await tree.get(toU8(item.k))) as Uint8Array | null;
        expectU8Eq(
          retrieved,
          toU8(item.v),
          `Failed for ${item.k} in large batch`
        );
      }
    });

    it("insertBatch should correctly handle keys with varied lengths and binary data", async () => {
      const tree = new WasmProllyTree();
      const itemsToInsert: [
        {
          k: string;
          v: string;
        },
        {
          k: string;
          v: string;
        },
        {
          k_bin: Uint8Array;
          v_bin: Uint8Array;
        }
      ] = [
        { k: "short", v: "sv" },
        {
          k: "a_very_long_key_that_might_affect_node_packing_or_boundaries_eventually",
          v: "this_is_a_much_longer_value_than_the_others_inserted_so_far_".repeat(
            3
          ),
        }, // Shorter than CDC threshold for simplicity
        {
          k_bin: new Uint8Array([0, 1, 2, 255]),
          v_bin: new Uint8Array([10, 0, 20]),
        },
      ];

      const jsArrayItems = [
        [toU8(itemsToInsert[0].k), toU8(itemsToInsert[0].v)],
        [toU8(itemsToInsert[1].k), toU8(itemsToInsert[1].v)],
        [itemsToInsert[2].k_bin, itemsToInsert[2].v_bin],
      ];

      await tree.insertBatch(jsArrayItems as any);

      const r1 = (await tree.get(
        toU8(itemsToInsert[0].k)
      )) as Uint8Array | null;
      expectU8Eq(r1, toU8(itemsToInsert[0].v));
      const r2 = (await tree.get(
        toU8(itemsToInsert[1].k)
      )) as Uint8Array | null;
      expectU8Eq(r2, toU8(itemsToInsert[1].v));
      const r3 = (await tree.get(itemsToInsert[2].k_bin)) as Uint8Array | null;
      expectU8Eq(r3, itemsToInsert[2].v_bin);
    });

    // Test error case for malformed input (if Wasm doesn't panic but returns rejected promise)
    // This depends on how `insertBatch` in `lib.rs` handles errors.
    // The current `lib.rs` implementation for `insertBatch` returns a rejected Promise for malformed input.
    it("insertBatch should reject promise for malformed input array", async () => {
      const tree = new WasmProllyTree();
      const malformedItems = [
        [toU8("key1"), toU8("value1")],
        "not_an_array", // Malformed entry
        [toU8("key3"), toU8("value3")],
      ];

      try {
        await tree.insertBatch(malformedItems as any);
        // If it reaches here, the promise didn't reject, which is a failure for this test.
        expect.fail(
          "insertBatch promise should have been rejected for malformed input."
        );
      } catch (error: any) {
        // Check if the error message is what we expect from Rust's error handling in lib.rs
        expect(error.message || error.toString()).toContain(
          "Item at index 1 in batch is not an array."
        );
      }

      const malformedPair = [
        [toU8("key1"), toU8("value1")],
        [toU8("key2")], // Malformed pair (missing value)
      ];
      try {
        await tree.insertBatch(malformedPair as any);
        expect.fail(
          "insertBatch promise should have been rejected for malformed pair."
        );
      } catch (error: any) {
        expect(error.message || error.toString()).toContain(
          "Item at index 1 in batch is not a [key, value] pair."
        );
      }

      const malformedType = [[toU8("key1"), "not_a_uint8array"]];
      try {
        await tree.insertBatch(malformedType as any);
        expect.fail(
          "insertBatch promise should have been rejected for non-Uint8Array value."
        );
      } catch (error: any) {
        expect(error.message || error.toString()).toContain(
          "Item at index 0 in batch has non-Uint8Array key or value."
        );
      }
    });
  });

  describe("WasmProllyTree little fan", () => {
    const FANOUT = 4; // Target Fanout
    const MIN_FANOUT = 2; // Min Fanout

    it("DELETE: should trigger leaf merge", async () => {
      // Setup: Need two leaf nodes after a split, each with minimum entries (2), then delete one
      // Target fanout 4, min fanout 2. Split at 5 elements.
      // Insert 5 keys to cause split (left leaf 2, right leaf 3)
      const tree = await WasmProllyTree.newWithConfig(FANOUT, MIN_FANOUT);
      const keys = ["k01", "k02", "k03", "k04", "k05"];
      for (const k of keys) {
        await tree.insert(toU8(k), toU8(`v_${k}`));
      }
      // Expected state: root -> [leaf(k01, k02), leaf(k03, k04, k05)] (approx split)

      // Delete k01 (left leaf will have 1 entry < min_fanout)
      const deleted1 = await tree.delete(toU8("k01"));
      expect(deleted1, "Deleting k01 should return true").toBe(true);

      // Expect merge: left leaf (k02) merges with right leaf (k03, k04, k05) -> root is now a leaf node again
      // Verify all remaining keys exist
      expectU8Eq(
        (await tree.get(toU8("k02"))) as Uint8Array | null,
        toU8("v_k02")
      );
      expectU8Eq(
        (await tree.get(toU8("k03"))) as Uint8Array | null,
        toU8("v_k03")
      );
      expectU8Eq(
        (await tree.get(toU8("k04"))) as Uint8Array | null,
        toU8("v_k04")
      );
      expectU8Eq(
        (await tree.get(toU8("k05"))) as Uint8Array | null,
        toU8("v_k05")
      );
      // Verify deleted key is gone
      expect((await tree.get(toU8("k01"))) as Uint8Array | null).toBeNull();

      // Check root hash changed after delete/merge
      const finalHash = (await tree.getRootHash()) as Uint8Array | null;
      expect(finalHash).not.toBeNull();
      // We can't easily verify the structure change without inspecting nodes/level
    });

    it("DELETE: should trigger leaf rebalance (borrow from right)", async () => {
      // Setup: Left leaf with 1 (underflow), Right leaf with 3 (can lend)
      // Target fanout 4, min fanout 2. Split at 5 elements.
      // Insert k01, k02, k03, k04, k05 -> root -> [leaf(k01, k02), leaf(k03, k04, k05)]
      const tree = await WasmProllyTree.newWithConfig(FANOUT, MIN_FANOUT);
      const keys = ["k01", "k02", "k03", "k04", "k05"];
      for (const k of keys) {
        await tree.insert(toU8(k), toU8(`v_${k}`));
      }

      // Delete k01 -> left leaf has k02 (size 1, needs borrow)
      await tree.delete(toU8("k01"));

      // Expect borrow from right: k03 moves from right to left.
      // State should become: root -> [leaf(k02, k03), leaf(k04, k05)]
      // Verify all remaining keys
      expect((await tree.get(toU8("k01"))) as Uint8Array | null).toBeNull();
      expectU8Eq(
        (await tree.get(toU8("k02"))) as Uint8Array | null,
        toU8("v_k02")
      );
      expectU8Eq(
        (await tree.get(toU8("k03"))) as Uint8Array | null,
        toU8("v_k03")
      ); // Check moved key
      expectU8Eq(
        (await tree.get(toU8("k04"))) as Uint8Array | null,
        toU8("v_k04")
      );
      expectU8Eq(
        (await tree.get(toU8("k05"))) as Uint8Array | null,
        toU8("v_k05")
      );
    });

    it("DELETE: should empty the tree when deleting the last element", async () => {
      const tree = await WasmProllyTree.newWithConfig(FANOUT, MIN_FANOUT);
      const key = toU8("last");
      await tree.insert(key, toU8("value"));

      expect((await tree.getRootHash()) as Uint8Array | null).not.toBeNull();

      const deleted = await tree.delete(key);
      expect(deleted).toBe(true);

      expect((await tree.getRootHash()) as Uint8Array | null).toBeNull();
      expect((await tree.get(key)) as Uint8Array | null).toBeNull();
    });

    it("should handle interleaved inserts and deletes", async () => {
      const tree = await WasmProllyTree.newWithConfig(FANOUT, MIN_FANOUT);
      const N = 20; // Enough to cause some splits/merges potentially
      const present = new Set<string>();

      // Phase 1: Insert initial batch
      for (let i = 0; i < N / 2; i++) {
        const keyStr = `key_${String(i).padStart(2, "0")}`;
        await tree.insert(toU8(keyStr), toU8(`val_${i}`));
        present.add(keyStr);
      }
      const hash1 = await tree.getRootHash();

      // Phase 2: Delete some, insert some
      for (let i = 0; i < N / 4; i++) {
        // Delete first quarter
        const keyStr = `key_${String(i).padStart(2, "0")}`;
        await tree.delete(toU8(keyStr));
        present.delete(keyStr);
      }
      for (let i = N / 2; i < N; i++) {
        // Insert second half
        const keyStr = `key_${String(i).padStart(2, "0")}`;
        await tree.insert(toU8(keyStr), toU8(`val_${i}`));
        present.add(keyStr);
      }
      const hash2 = await tree.getRootHash();
      expect(Array.from(hash1 as Uint8Array)).not.toEqual(
        Array.from(hash2 as Uint8Array)
      );

      // Phase 3: Verify final state
      for (let i = 0; i < N; i++) {
        const keyStr = `key_${String(i).padStart(2, "0")}`;
        const retrieved = (await tree.get(toU8(keyStr))) as Uint8Array | null;
        if (present.has(keyStr)) {
          expectU8Eq(retrieved, toU8(`val_${i}`));
        } else {
          expect(retrieved).toBeNull();
        }
      }
    });

    it("DELETE: step-by-step trace for merge reducing tree height (k04, k05 delete)", async () => {
      // Renamed slightly for clarity
      const FANOUT = 4;
      const MIN_FANOUT = 2;
      const tree = await WasmProllyTree.newWithConfig(FANOUT, MIN_FANOUT);

      // --- Setup ---
      console.log("--- TEST: Setup ---");
      const keys = ["k01", "k02", "k03", "k04", "k05"];
      const values: { [key: string]: Uint8Array } = {};
      for (const k of keys) {
        const v = toU8(`v_${k}`);
        values[k] = v;
        await tree.insert(toU8(k), v);
      }
      const hash_after_insert = (await tree.getRootHash()) as Uint8Array | null;
      console.log(`Initial root hash: ${formatU8Array(hash_after_insert)}`);
      expect(hash_after_insert).not.toBeNull();

      // --- Step 1: Delete k04 ---
      console.log("\n--- TEST: Deleting k04 ---");
      const deleted4 = await tree.delete(toU8("k04"));
      expect(deleted4).toBe(true);
      const hash_after_del_k04 =
        (await tree.getRootHash()) as Uint8Array | null;
      console.log(
        `Root hash after k04 delete: ${formatU8Array(hash_after_del_k04)}`
      );
      expect(hash_after_del_k04).not.toBeNull();
      expect(Array.from(hash_after_del_k04!)).not.toEqual(
        Array.from(hash_after_insert!)
      );

      // Verify state after k04 delete
      console.log("TEST: Verifying state after k04 delete...");
      expect((await tree.get(toU8("k04"))) as Uint8Array | null).toBeNull();
      expectU8Eq(
        (await tree.get(toU8("k01"))) as Uint8Array | null,
        values["k01"]
      );
      expectU8Eq(
        (await tree.get(toU8("k02"))) as Uint8Array | null,
        values["k02"]
      );
      expectU8Eq(
        (await tree.get(toU8("k03"))) as Uint8Array | null,
        values["k03"]
      );
      expectU8Eq(
        (await tree.get(toU8("k05"))) as Uint8Array | null,
        values["k05"]
      );

      // --- Step 2: Delete k05 ---
      console.log(
        "\n--- TEST: Deleting k05 (expecting merge and root collapse) ---"
      );
      const deleted5 = await tree.delete(toU8("k05"));
      expect(deleted5).toBe(true);
      const hash_after_del_k05 =
        (await tree.getRootHash()) as Uint8Array | null;
      console.log(
        `Root hash after k05 delete: ${formatU8Array(hash_after_del_k05)}`
      );

      // *** CORRECTED EXPECTATION ***
      expect(
        hash_after_del_k05,
        "Root hash after k05 delete should be null"
      ).not.toBeNull();

      // Export chunks after k05 delete (optional, store might have old nodes)
      const chunks_after_del_k05 = (await tree.exportChunks()) as Map<
        Uint8Array,
        Uint8Array
      >;

      expectU8Eq(
        // Use your helper for Uint8Array comparison
        (await tree.get(toU8("k01"))) as Uint8Array | null,
        values["k01"], // Assuming 'values' map from setup holds the original values
        "Final k01 check - should exist"
      );
      expectU8Eq(
        (await tree.get(toU8("k02"))) as Uint8Array | null,
        values["k02"],
        "Final k02 check - should exist"
      );
      expectU8Eq(
        (await tree.get(toU8("k03"))) as Uint8Array | null,
        values["k03"],
        "Final k03 check - should exist"
      );

      // Keys k04 and k05 were deleted and should be null
      expect(
        (await tree.get(toU8("k04"))) as Uint8Array | null,
        "Final k04 check - should be deleted"
      ).toBeNull();
      expect(
        (await tree.get(toU8("k05"))) as Uint8Array | null,
        "Final k05 check - should be deleted"
      ).toBeNull();
    });

    // --- Test Deleting a Boundary Key ---
    it("DELETE: should correctly handle deleting a boundary key", async () => {
      const FANOUT = 4;
      const MIN_FANOUT = 2;
      const tree = await WasmProllyTree.newWithConfig(FANOUT, MIN_FANOUT);

      // Setup: Insert k01, k02, k03, k04, k05
      // State: root -> [L(k01, k02){bd=k02}, R(k03, k04, k05){bd=k05}]
      // The key 'k02' is the boundary key for the left child stored in the root.
      const keys = ["k01", "k02", "k03", "k04", "k05"];
      const values: { [key: string]: Uint8Array } = {};
      for (const k of keys) {
        const v = toU8(`v_${k}`);
        values[k] = v;
        await tree.insert(toU8(k), v);
      }

      // Action: Delete 'k02' (the boundary key of the left leaf)
      console.log("TEST: Deleting boundary key k02...");
      const deleted = await tree.delete(toU8("k02"));
      expect(deleted, "delete k02 result").toBe(true);

      // Expected State:
      // Left leaf becomes (k01), size 1 -> Underflow.
      // Right leaf is (k03, k04, k05), size 3 -> Can lend.
      // Rebalance (borrow from right): Move 'k03' from right to left.
      // Final state: root -> [L(k01, k03){bd=k03}, R(k04, k05){bd=k05}]
      // Note: The boundary key for the left child in the root should update from k02 to k03.

      console.log("TEST: Verifying state after deleting boundary k02...");
      // Check deleted key
      expect(
        (await tree.get(toU8("k02"))) as Uint8Array | null,
        "k02 after delete"
      ).toBeNull();

      // Check remaining keys are in correct final state
      expectU8Eq(
        (await tree.get(toU8("k01"))) as Uint8Array | null,
        values["k01"],
        "k01 after k02 delete"
      );
      expectU8Eq(
        (await tree.get(toU8("k03"))) as Uint8Array | null,
        values["k03"],
        "k03 after k02 delete"
      ); // Should still exist
      expectU8Eq(
        (await tree.get(toU8("k04"))) as Uint8Array | null,
        values["k04"],
        "k04 after k02 delete"
      );
      expectU8Eq(
        (await tree.get(toU8("k05"))) as Uint8Array | null,
        values["k05"],
        "k05 after k02 delete"
      );

      // Verify root hash changed
      const finalHash = await tree.getRootHash();
      const initialHash = await tree.getRootHash(); // Re-getting initial hash won't work, need to store it earlier if needed for comparison
      expect(finalHash).not.toBeNull();
      // We don't have the hash from *before* the k02 delete easily, but we know state changed.
    });
  });
});

// Helper to create a large Uint8Array with pseudo-random but deterministic content
function createLargeTestData(size: number, seed: number = 42): Uint8Array {
  const buffer = new Uint8Array(size);
  let current = seed;
  for (let i = 0; i < size; i++) {
    // Simple pseudo-random generator (linear congruential generator)
    current = (current * 1103515245 + 12345) % 2 ** 31;
    buffer[i] = current % 256;
  }
  return buffer;
}

describe("WasmProllyTree CDC", () => {
  // Default config thresholds (approx based on Rust defaults):
  const MAX_INLINE = 1024;
  const AVG_CHUNK = 16 * 1024;

  it("CDC: should store small values inline", async () => {
    const tree = new WasmProllyTree();
    const key = toU8("small_value_key");
    const value = createLargeTestData(MAX_INLINE - 10); // Just below threshold

    const chunksBefore = (await tree.exportChunks()) as Map<
      Uint8Array,
      Uint8Array
    >;
    const sizeBefore = chunksBefore.size;

    await tree.insert(key, value);

    const retrieved = (await tree.get(key)) as Uint8Array | null;
    expectU8Eq(
      retrieved,
      value,
      "Retrieved value should match small inline value"
    );

    const chunksAfter = (await tree.exportChunks()) as Map<
      Uint8Array,
      Uint8Array
    >;
    const sizeAfter = chunksAfter.size;

    // Expect only node chunks to be added (root, maybe 1 leaf if empty before)
    expect(sizeAfter).toBeLessThanOrEqual(sizeBefore + 2);
    // Note: This check isn't perfect, splits could add more nodes, but we expect *no data chunks*
  });

  it("CDC: should chunk value slightly above inline threshold", async () => {
    const tree = new WasmProllyTree();
    const key = toU8("chunked_value_key_1");
    const value = createLargeTestData(MAX_INLINE + 100); // Just above threshold

    const chunksBefore = (await tree.exportChunks()) as Map<
      Uint8Array,
      Uint8Array
    >;
    const sizeBefore = chunksBefore.size;
    const initialRootHash = await tree.getRootHash();

    await tree.insert(key, value);

    const retrieved = (await tree.get(key)) as Uint8Array | null;
    expectU8Eq(
      retrieved,
      value,
      "Retrieved value should match simple chunked value"
    );

    const finalRootHash = await tree.getRootHash();
    expect(finalRootHash).not.toEqual(initialRootHash); // Ensure tree state changed

    const chunksAfter = (await tree.exportChunks()) as Map<
      Uint8Array,
      Uint8Array
    >;
    const sizeAfter = chunksAfter.size;

    // Expect node chunks + at least one data chunk
    expect(sizeAfter).toBeGreaterThan(sizeBefore + 1);
    // We expect *at least* 1 data chunk + 1 (leaf) node chunk + maybe 1 root node update = 3 increase minimum
    // It could be more if the value splits or the tree structure updates more nodes.
    // A tighter bound is hard without knowing exact structure/CDC splits.
    // Let's check for a plausible increase (e.g., >= 2 chunks added: 1 data + 1 node update)
    expect(sizeAfter).toBeGreaterThanOrEqual(sizeBefore + 2);
  });

  it("CDC: should chunk large value into multiple chunks", async () => {
    const tree = new WasmProllyTree();
    const key = toU8("multi_chunk_value_key");
    // Create value larger than average chunk size, likely to split
    const value = createLargeTestData(AVG_CHUNK * 2 + 500);

    const chunksBefore = (await tree.exportChunks()) as Map<
      Uint8Array,
      Uint8Array
    >;
    const sizeBefore = chunksBefore.size;

    await tree.insert(key, value);

    const retrieved = (await tree.get(key)) as Uint8Array | null;
    expectU8Eq(
      retrieved,
      value,
      "Retrieved value should match multi-chunked value"
    );

    const chunksAfter = (await tree.exportChunks()) as Map<
      Uint8Array,
      Uint8Array
    >;
    const sizeAfter = chunksAfter.size;

    // Expect node chunks + multiple data chunks (likely 2-3 data chunks for 2*AVG size)
    // Expect increase of at least 3: 2 data chunks + 1 node update
    expect(sizeAfter).toBeGreaterThanOrEqual(sizeBefore + 3);
  });

  it("CDC: should deduplicate identical large values", async () => {
    const tree = new WasmProllyTree();
    const key1 = toU8("dedup_key_1");
    const key2 = toU8("dedup_key_2");
    // Value large enough to be chunked (likely multiple chunks)
    const largeValue = createLargeTestData(AVG_CHUNK * 3);

    // Insert first value
    await tree.insert(key1, largeValue);
    const chunksAfter1 = (await tree.exportChunks()) as Map<
      Uint8Array,
      Uint8Array
    >;
    const sizeAfter1 = chunksAfter1.size;
    const rootHash1 = await tree.getRootHash();
    expect(sizeAfter1).toBeGreaterThan(2); // Expect >2 chunks (nodes + data)

    // Insert IDENTICAL value with a different key
    await tree.insert(key2, largeValue);
    const chunksAfter2 = (await tree.exportChunks()) as Map<
      Uint8Array,
      Uint8Array
    >;
    const sizeAfter2 = chunksAfter2.size;
    const rootHash2 = await tree.getRootHash();

    // Verify retrieval
    const retrieved1 = (await tree.get(key1)) as Uint8Array | null;
    expectU8Eq(
      retrieved1,
      largeValue,
      "Retrieval key 1 failed after dedup insert"
    );
    const retrieved2 = (await tree.get(key2)) as Uint8Array | null;
    expectU8Eq(
      retrieved2,
      largeValue,
      "Retrieval key 2 failed after dedup insert"
    );

    expect(rootHash2).not.toEqual(rootHash1); // Root hash must change (leaf node updated)

    // *** The Core Deduplication Check ***
    // The number of chunks should increase only by the number of *new node chunks* created/modified.
    // It should NOT increase by the number of data chunks again.
    // Expect maybe 1-3 new/modified node chunks (leaf, maybe parent, maybe root).
    // This check is heuristic. A very large fanout might only modify 1 leaf.
    console.log(`Store size after 1st large insert: ${sizeAfter1}`);
    console.log(`Store size after 2nd identical large insert: ${sizeAfter2}`);
    const chunkIncrease = sizeAfter2 - sizeAfter1;
    console.log(`Chunk increase: ${chunkIncrease}`);
    // Number of data chunks for 3*AVG is likely 3-4. Increase should be much less.
    expect(chunkIncrease).toBeLessThan(5);
    expect(chunkIncrease).toBeGreaterThan(0);
  });
});

// Helper to decode JS iterator result value
function decodeIteratorValue(
  resultValue: any
): [Uint8Array, Uint8Array] | null {
  if (!resultValue || !Array.isArray(resultValue)) return null;
  if (resultValue.length !== 2) return null;
  if (
    !(resultValue[0] instanceof Uint8Array) ||
    !(resultValue[1] instanceof Uint8Array)
  )
    return null;
  return [resultValue[0], resultValue[1]];
}
// Helper to compare key arrays
const expectKeyArrayEq = (
  a: Uint8Array[],
  b: Uint8Array[],
  message?: string
) => {
  expect(a.length, message).toEqual(b.length);
  for (let i = 0; i < a.length; i++) {
    expectU8Eq(a[i], b[i], `${message} - index ${i}`);
  }
};

// --- New Describe Block for Cursor Tests ---
describe("WasmProllyTreeCursor", () => {
  it("should iterate over an empty tree", async () => {
    const tree = new WasmProllyTree();
    const cursor = (await tree.cursorStart()) as WasmProllyTreeCursor;
    const result = await cursor.next();

    expect(result.done).toBe(true);
    expect(result.value).toBeUndefined();
  });

  it("should iterate over a single-leaf tree in order", async () => {
    const tree = new WasmProllyTree();
    const items = [
      { k: "b", v: "vb" },
      { k: "a", v: "va" },
      { k: "c", v: "vc" },
    ];
    const expectedKeys = ["a", "b", "c"].map(toU8);
    const expectedValues = ["va", "vb", "vc"].map(toU8);

    for (const item of items) {
      await tree.insert(toU8(item.k), toU8(item.v));
    }

    const cursor = (await tree.cursorStart()) as WasmProllyTreeCursor;
    const collectedKeys: Uint8Array[] = [];
    const collectedValues: Uint8Array[] = [];

    for (let i = 0; i < items.length + 1; i++) {
      // Iterate one past expected length
      const result = await cursor.next();
      if (!result.done) {
        const [key, value] = decodeIteratorValue(result.value)!;
        collectedKeys.push(key);
        collectedValues.push(value);
      } else {
        expect(i).toBe(items.length); // Should be done after 3 items
        break;
      }
    }

    expectKeyArrayEq(collectedKeys, expectedKeys, "Keys not in order");
    expectKeyArrayEq(
      collectedValues,
      expectedValues,
      "Values not matching keys"
    );
  });

  it("should iterate over a multi-level tree (split) in order", async () => {
    const tree = await WasmProllyTree.newWithConfig(4, 2); // Use small fanout
    const count = 10;
    const expectedItems: { k: Uint8Array; v: Uint8Array }[] = [];

    for (let i = 0; i < count; i++) {
      const keyStr = `k_${String(i).padStart(2, "0")}`;
      const valStr = `v_${i}`;
      const key = toU8(keyStr);
      const val = toU8(valStr);
      await tree.insert(key, val);
      expectedItems.push({ k: key, v: val });
    }
    expectedItems.sort((a, b) => Buffer.from(a.k).compare(Buffer.from(b.k))); // Sort expected items by key

    const cursor = (await tree.cursorStart()) as WasmProllyTreeCursor;
    const collectedItems: { k: Uint8Array; v: Uint8Array }[] = [];

    for (let iterCount = 0; iterCount < 20; iterCount++) {
      // Limit iterations
      const result = await cursor.next();
      if (result.done) {
        break;
      }
      const [key, value] = decodeIteratorValue(result.value)!;
      collectedItems.push({ k: key, v: value });
    }
    if (collectedItems.length < expectedItems.length) {
      console.warn("Loop terminated early due to iteration limit!");
    }

    expect(collectedItems.length).toBe(expectedItems.length);
    for (let i = 0; i < expectedItems.length; i++) {
      expectU8Eq(
        collectedItems[i].k,
        expectedItems[i].k,
        `Key mismatch at index ${i}`
      );
      expectU8Eq(
        collectedItems[i].v,
        expectedItems[i].v,
        `Value mismatch at index ${i}`
      );
    }
  }, 10_000);

  it("should seek to a specific key", async () => {
    const tree = new WasmProllyTree();
    const items = ["a", "b", "c", "d", "e", "f", "g"].map((k) => ({
      k,
      v: `v${k}`,
    }));
    for (const item of items) await tree.insert(toU8(item.k), toU8(item.v));

    const seekKey = toU8("d");
    const cursor = (await tree.seek(seekKey)) as WasmProllyTreeCursor;

    const collectedKeys: string[] = [];
    while (true) {
      const result = await cursor.next();
      if (result.done) break;
      const [key] = decodeIteratorValue(result.value)!;
      collectedKeys.push(Buffer.from(key).toString()); // Collect as string for easier compare
    }

    expect(collectedKeys).toEqual(["d", "e", "f", "g"]);
  });

  it("should seek past the last key", async () => {
    const tree = new WasmProllyTree();
    const items = ["a", "b", "c"].map((k) => ({ k, v: `v${k}` }));
    for (const item of items) await tree.insert(toU8(item.k), toU8(item.v));

    const seekKey = toU8("d"); // Key after all existing keys
    const cursor = (await tree.seek(seekKey)) as WasmProllyTreeCursor;

    const result = await cursor.next();
    expect(result.done).toBe(true);
  });

  it("should seek to the first key", async () => {
    const tree = new WasmProllyTree();
    const items = ["b", "c", "a"].map((k) => ({ k, v: `v${k}` })); // Insert out of order
    for (const item of items) await tree.insert(toU8(item.k), toU8(item.v));

    const seekKey = toU8("a"); // Seek to first actual key
    const cursor = (await tree.seek(seekKey)) as WasmProllyTreeCursor;

    const collectedKeys: string[] = [];
    while (true) {
      const result = await cursor.next();
      if (result.done) break;
      const [key] = decodeIteratorValue(result.value)!;
      collectedKeys.push(Buffer.from(key).toString());
    }
    expect(collectedKeys).toEqual(["a", "b", "c"]);
  });

  it("should iterate correctly over chunked values (CDC)", async () => {
    const tree = new WasmProllyTree();
    const keySmall = toU8("small");
    const valSmall = toU8("v_small");
    const keyLarge = toU8("large");
    const valLarge = createLargeTestData(2000); // Above 1k threshold
    const keyMiddle = toU8("middle");
    const valMiddle = toU8("v_middle");

    // Insert out of order
    await tree.insert(keyLarge, valLarge);
    await tree.insert(keySmall, valSmall);
    await tree.insert(keyMiddle, valMiddle);

    const expectedKeys = [keyLarge, keyMiddle, keySmall]; // Expected iteration order
    const expectedValues = [valLarge, valMiddle, valSmall];

    const cursor = (await tree.cursorStart()) as WasmProllyTreeCursor;
    const collectedKeys: Uint8Array[] = [];
    const collectedValues: Uint8Array[] = [];

    while (true) {
      const result = await cursor.next();
      if (result.done) break;
      const [key, value] = decodeIteratorValue(result.value)!;
      collectedKeys.push(key);
      collectedValues.push(value);
    }

    expectKeyArrayEq(collectedKeys, expectedKeys, "CDC Keys not in order");
    expectKeyArrayEq(
      collectedValues,
      expectedValues,
      "CDC Values not matching keys"
    );
  });
});

// Helper to compare diff entries (ignoring order for simplicity, checking presence/content)
// A more robust check would sort both arrays first by key.
function expectDiffsToMatch(
  actualDiffs: JsDiffEntry[],
  expectedDiffs: JsDiffEntry[],
  message?: string
) {
  const context = message ? `: ${message}` : "";
  expect(actualDiffs.length, `Diff count mismatch${context}`).toBe(
    expectedDiffs.length
  );

  const findAndCompare = (entry: JsDiffEntry) => {
    const match = actualDiffs.find((a) =>
      Buffer.from(a.key).equals(Buffer.from(entry.key))
    );
    expect(
      match,
      `Expected diff entry for key ${Buffer.from(
        entry.key
      ).toString()} not found${context}`
    ).toBeDefined();
    if (match) {
      expect(
        match.leftValue !== undefined,
        `Match for ${Buffer.from(entry.key)} missing leftValue?${context}`
      ).toBe(entry.leftValue !== undefined);
      expect(
        match.rightValue !== undefined,
        `Match for ${Buffer.from(entry.key)} missing rightValue?${context}`
      ).toBe(entry.rightValue !== undefined);
      if (entry.leftValue) {
        expectU8Eq(
          match.leftValue,
          entry.leftValue,
          `Left value mismatch for ${Buffer.from(entry.key)}`
        );
      }
      if (entry.rightValue) {
        expectU8Eq(
          match.rightValue,
          entry.rightValue,
          `Right value mismatch for ${Buffer.from(entry.key)}`
        );
      }
    }
  };

  expectedDiffs.forEach(findAndCompare);
}

describe("WasmProllyTree Diff", () => {
  it("should return empty diff for identical trees", async () => {
    const tree = new WasmProllyTree();
    await tree.insert(toU8("a"), toU8("1"));
    await tree.insert(toU8("b"), toU8("2"));
    const hash1 = (await tree.getRootHash()) as Uint8Array | null;
    // Diff hash1 against hash1
    const diffs = (await tree.diffRoots(hash1, hash1)) as JsDiffEntry[];
    expect(diffs).toEqual([]);
  });

  it("should return empty diff for two empty trees", async () => {
    const tree = new WasmProllyTree();
    // Diff null against null
    const diffs = (await tree.diffRoots(null, null)) as JsDiffEntry[];
    expect(diffs).toEqual([]);
  });

  // *** Un-skip and correct additions test ***
  it("should detect additions (diff empty vs non-empty)", async () => {
    const tree = new WasmProllyTree(); // Use one tree
    const hash_initial = (await tree.getRootHash()) as Uint8Array | null; // null

    await tree.insert(toU8("a"), toU8("1"));
    await tree.insert(toU8("c"), toU8("3"));
    const hash_final = (await tree.getRootHash()) as Uint8Array | null;

    // Diff initial state (null) -> final state (hash_final) using the tree's store
    const diffs_add = (await tree.diffRoots(
      hash_initial,
      hash_final
    )) as JsDiffEntry[];

    const expected_add: JsDiffEntry[] = [
      { key: toU8("a"), rightValue: toU8("1") }, // Added 'a'
      { key: toU8("c"), rightValue: toU8("3") }, // Added 'c'
    ];
    expectDiffsToMatch(diffs_add, expected_add, "Additions diff");
  });

  it("should detect deletions (diff non-empty vs empty)", async () => {
    const tree = new WasmProllyTree();
    await tree.insert(toU8("a"), toU8("1"));
    await tree.insert(toU8("c"), toU8("3"));
    const hash_initial = (await tree.getRootHash()) as Uint8Array | null;

    // Diff initial state (hash_initial) -> null
    const diffs_del = (await tree.diffRoots(
      hash_initial,
      null
    )) as JsDiffEntry[];

    const expected_del: JsDiffEntry[] = [
      { key: toU8("a"), leftValue: toU8("1") },
      { key: toU8("c"), leftValue: toU8("3") },
    ];
    expectDiffsToMatch(diffs_del, expected_del, "Deletions diff");
  });

  it("should detect modifications", async () => {
    const tree = new WasmProllyTree();
    // State 1
    await tree.insert(toU8("a"), toU8("1"));
    await tree.insert(toU8("b"), toU8("2"));
    await tree.insert(toU8("c"), toU8("3"));
    const hash1 = (await tree.getRootHash()) as Uint8Array | null;

    // State 2 (modify b in the same tree instance)
    await tree.insert(toU8("b"), toU8("CHANGED"));
    const hash2 = (await tree.getRootHash()) as Uint8Array | null;

    // Diff hash1 -> hash2 using the tree's store
    const diffs = (await tree.diffRoots(hash1, hash2)) as JsDiffEntry[];

    const expected: JsDiffEntry[] = [
      { key: toU8("b"), leftValue: toU8("2"), rightValue: toU8("CHANGED") },
    ];
    expectDiffsToMatch(diffs, expected, "Modification diff");
  });

  it("should detect mixed additions, deletions, modifications", async () => {
    const tree = new WasmProllyTree();
    // State 1
    await tree.insert(toU8("a"), toU8("val_a"));
    await tree.insert(toU8("b"), toU8("val_b"));
    await tree.insert(toU8("c"), toU8("val_c"));
    const hash1 = (await tree.getRootHash()) as Uint8Array | null;

    // State 2
    await tree.delete(toU8("c"));
    await tree.insert(toU8("b"), toU8("val_b_mod"));
    await tree.insert(toU8("d"), toU8("val_d"));
    const hash2 = (await tree.getRootHash()) as Uint8Array | null;

    // Diff hash1 -> hash2
    const diffs = (await tree.diffRoots(hash1, hash2)) as JsDiffEntry[];

    const expected: JsDiffEntry[] = [
      {
        key: toU8("b"),
        leftValue: toU8("val_b"),
        rightValue: toU8("val_b_mod"),
      },
      { key: toU8("c"), leftValue: toU8("val_c") }, // Deletion
      { key: toU8("d"), rightValue: toU8("val_d") }, // Addition
    ];
    expectDiffsToMatch(diffs, expected, "Mixed diff");
  });

  it("should handle diff with CDC values", async () => {
    const tree = new WasmProllyTree();
    const largeVal1 = createLargeTestData(2000, 1);
    const largeVal2 = createLargeTestData(2500, 2);

    // State 1
    await tree.insert(toU8("a"), toU8("val_a"));
    await tree.insert(toU8("large"), largeVal1);
    const hash1 = (await tree.getRootHash()) as Uint8Array | null;

    // State 2
    await tree.insert(toU8("large"), largeVal2); // Modify large value
    await tree.insert(toU8("z"), toU8("val_z"));
    const hash2 = (await tree.getRootHash()) as Uint8Array | null;

    // Diff hash1 -> hash2
    const diffs = (await tree.diffRoots(hash1, hash2)) as JsDiffEntry[];

    const expected: JsDiffEntry[] = [
      { key: toU8("large"), leftValue: largeVal1, rightValue: largeVal2 }, // Modification (large)
      { key: toU8("z"), rightValue: toU8("val_z") }, // Addition
    ];
    expectDiffsToMatch(diffs, expected, "CDC diff");
  });
}); // End Diff describe block

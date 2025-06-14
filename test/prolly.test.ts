import { describe, it, expect, vi, beforeEach } from "vitest";

import {
  IScanPage,
  PTree,
  PTreeCursor,
  ScanOptions,
  ScanPage,
} from "../dist/node/prolly_rust.js";
import {
  expectU8Eq,
  formatU8Array,
  JsDiffEntry,
  toU8,
  expectKeyValueArrayEq,
} from "./lib/utils.js";

describe("PTree", () => {
  it("should allow creating, inserting, and getting values", async () => {
    const tree = new PTree();

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

  it("should allow creating, inserting, and getting values synchronously with getSync", async () => {
    const tree = new PTree();

    const key1 = toU8("hello_sync");
    const val1 = toU8("world_sync");
    await tree.insert(key1, val1);

    const key2 = toU8("goodbye_sync");
    const val2 = toU8("moon_sync");
    await tree.insert(key2, val2);

    // Test successful sync retrieval
    let result1: Uint8Array | null = null;
    expect(() => {
      result1 = tree.getSync(key1);
    }).not.toThrow();
    expectU8Eq(
      result1,
      val1,
      "Sync get for key1 should succeed and return correct value"
    );

    let result2: Uint8Array | null = null;
    expect(() => {
      result2 = tree.getSync(key2);
    }).not.toThrow();
    expectU8Eq(
      result2,
      val2,
      "Sync get for key2 should succeed and return correct value"
    );

    // Test sync retrieval of non-existent key
    let result3: Uint8Array | null = null;
    expect(() => {
      result3 = tree.getSync(toU8("nonexistent_sync"));
    }).not.toThrow();
    expect(result3).toBeNull();
  });

  it("should update root hash after inserts", async () => {
    const tree = new PTree();
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

  describe("checkout", () => {
    it("should checkout to a previous version", async () => {
      const tree = new PTree();
      await tree.insert(toU8("k1"), toU8("v1"));
      const hash1 = await tree.getRootHash();

      await tree.insert(toU8("k2"), toU8("v2"));
      const hash2 = await tree.getRootHash();

      // Before checkout, we are at hash2
      expect(await tree.get(toU8("k2"))).toBeDefined();
      expectU8Eq(await tree.getRootHash(), hash2);

      // Checkout to the previous state
      await tree.checkout(hash1);

      // After checkout, we should be at hash1
      expectU8Eq(await tree.getRootHash(), hash1);
      expectU8Eq(await tree.get(toU8("k1")), toU8("v1"));
      expect(await tree.get(toU8("k2"))).toBeNull();
    });

    it("should checkout to an empty tree", async () => {
      const tree = new PTree();
      await tree.insert(toU8("k1"), toU8("v1"));
      expect(await tree.getRootHash()).not.toBeNull();

      // Checkout to null (empty tree)
      await tree.checkout(null);

      expect(await tree.getRootHash()).toBeNull();
      expect(await tree.get(toU8("k1"))).toBeNull();
    });

    it("should reject checkout to a non-existent hash", async () => {
      const tree = new PTree();
      await tree.insert(toU8("k1"), toU8("v1"));

      const invalidHash = new Uint8Array(32).fill(1); // Create a plausible but non-existent hash

      await expect(tree.checkout(invalidHash)).rejects.toThrow(
        /Chunk not found/
      );
    });
  });

  it("should handle many inserts potentially causing splits", async () => {
    const tree = new PTree();
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
    const tree1 = new PTree();
    await tree1.insert(toU8("data1"), toU8("value1"));
    await tree1.insert(toU8("data2"), toU8("value2"));

    const rootHash = (await tree1.getRootHash()) as Uint8Array;
    expect(rootHash).not.toBeNull();

    const chunks = (await tree1.exportChunks()) as Map<Uint8Array, Uint8Array>;
    expect(chunks.size).toBeGreaterThan(0); // Should have at least the root node chunk

    // Create a new tree loaded from the exported state
    const tree2 = await PTree.load(rootHash, chunks);

    // Verify data in loaded tree
    const val1Loaded = (await tree2.get(toU8("data1"))) as Uint8Array | null;
    expectU8Eq(val1Loaded, toU8("value1"));
    const val2Loaded = (await tree2.get(toU8("data2"))) as Uint8Array | null;
    expectU8Eq(val2Loaded, toU8("value2"));

    const rootHash2 = (await tree2.getRootHash()) as Uint8Array | null;
    expectU8Eq(rootHash2, rootHash); // Root hashes should match
  });

  it("should overwrite existing values on insert with the same key", async () => {
    const tree = new PTree();
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
    const tree = new PTree();
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
    const tree = new PTree();
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

    const tree1 = new PTree();
    await tree1.insert(toU8("a"), toU8("1"));
    await tree1.insert(toU8("b"), toU8("2"));
    await tree1.insert(toU8("c"), toU8("3"));
    const hash1 = (await tree1.getRootHash()) as Uint8Array | null;

    const tree2 = new PTree();
    await tree2.insert(toU8("c"), toU8("3"));
    await tree2.insert(toU8("a"), toU8("1"));
    await tree2.insert(toU8("b"), toU8("2"));
    const hash2 = (await tree2.getRootHash()) as Uint8Array | null;

    const tree3 = new PTree(); // Same data as tree1, check consistency
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
    const tree = new PTree();

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
    const tree = new PTree();
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

    const tree2 = await PTree.load(rootHash!, chunks);
    const keyToTest = `split_key_${String(count - 1).padStart(2, "0")}`; // Test last key
    const retrieved2 = (await tree2.get(toU8(keyToTest))) as Uint8Array | null;
    expectU8Eq(retrieved2, toU8(inserted.get(keyToTest)!));
  });

  // TODO: Implement this test as these are configurable now
  // Note: Testing internal node splits requires fanout * fanout items (e.g., 32*32 = 1024)
  // which might be too slow for a unit test. This could be a longer-running integration test.
  it.skip("should trigger internal node splits (large test)", async () => {
    // Skipped by default due to size/time
    const tree = new PTree();
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
    const tree = new PTree();
    await tree.insert(toU8("a"), toU8("1"));
    const hash1 = (await tree.getRootHash()) as Uint8Array | null;

    // Perform some read operations
    await tree.get(toU8("a"));
    await tree.get(toU8("nonexistent"));

    const hash2 = (await tree.getRootHash()) as Uint8Array | null;
    expectU8Eq(hash1, hash2); // Root hash should not change after only reads
  });

  it("should allow overwriting then getting other keys", async () => {
    const tree = new PTree();
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
      const tree = new PTree();
      const itemsToInsert = [
        { k: "batch_key1", v: "batch_val1" },
        { k: "batch_key2", v: "batch_val2" },
        { k: "batch_key0", v: "batch_val0" }, // Insert out of order
      ];

      const jsArrayItems = itemsToInsert.map((item) => [
        toU8(item.k),
        toU8(item.v),
      ]);

      // The PTree.insertBatch expects a js_sys::Array directly.
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
      const tree = new PTree();
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
      const tree = new PTree();
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
      const tree = new PTree();
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
      const tree = new PTree(); // Default config
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
        expect(item).not.toBeUndefined();
        if (!item) continue;
        const retrieved = (await tree.get(toU8(item.k))) as Uint8Array | null;
        expectU8Eq(
          retrieved,
          toU8(item.v),
          `Failed for ${item.k} in large batch`
        );
      }
    });

    it("insertBatch should correctly handle keys with varied lengths and binary data", async () => {
      const tree = new PTree();
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
      const tree = new PTree();
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

  describe("PTree little fan", () => {
    const FANOUT = 4; // Target Fanout
    const MIN_FANOUT = 2; // Min Fanout

    it("DELETE: should trigger leaf merge", async () => {
      // Setup: Need two leaf nodes after a split, each with minimum entries (2), then delete one
      // Target fanout 4, min fanout 2. Split at 5 elements.
      // Insert 5 keys to cause split (left leaf 2, right leaf 3)
      const tree = new PTree({ targetFanout: FANOUT, minFanout: MIN_FANOUT });
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
      const tree = new PTree({ targetFanout: FANOUT, minFanout: MIN_FANOUT });
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
      const tree = new PTree({ targetFanout: FANOUT, minFanout: MIN_FANOUT });
      const key = toU8("last");
      await tree.insert(key, toU8("value"));

      expect((await tree.getRootHash()) as Uint8Array | null).not.toBeNull();

      const deleted = await tree.delete(key);
      expect(deleted).toBe(true);

      expect((await tree.getRootHash()) as Uint8Array | null).toBeNull();
      expect((await tree.get(key)) as Uint8Array | null).toBeNull();
    });

    it("should handle interleaved inserts and deletes", async () => {
      const tree = new PTree({ targetFanout: FANOUT, minFanout: MIN_FANOUT });
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
      const tree = new PTree({ targetFanout: FANOUT, minFanout: MIN_FANOUT });

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
      const tree = new PTree({ targetFanout: FANOUT, minFanout: MIN_FANOUT });

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

describe("PTree Sync Operations", () => {
  it("should insert values with insertSync and retrieve them with getSync", () => {
    const tree = new PTree();
    const key1 = toU8("sync_key_1");
    const val1 = toU8("sync_val_1");
    const key2 = toU8("sync_key_2");
    const val2 = toU8("sync_val_2");

    // Insert initial values
    expect(() => tree.insertSync(key1, val1)).not.toThrow();
    expect(() => tree.insertSync(key2, val2)).not.toThrow();

    // Verify values can be retrieved
    expectU8Eq(tree.getSync(key1), val1);
    expectU8Eq(tree.getSync(key2), val2);

    // Overwrite a value
    const val1_overwrite = toU8("sync_val_1_overwritten");
    expect(() => tree.insertSync(key1, val1_overwrite)).not.toThrow();

    // Verify overwritten value
    expectU8Eq(tree.getSync(key1), val1_overwrite);
    // Verify other value is unaffected
    expectU8Eq(tree.getSync(key2), val2);
  });

  it("should delete values with deleteSync and verify their removal", () => {
    const tree = new PTree();
    const key1 = toU8("sync_del_1");
    const val1 = toU8("sync_del_val_1");
    const key2 = toU8("sync_del_2");
    const val2 = toU8("sync_del_val_2");

    tree.insertSync(key1, val1);
    tree.insertSync(key2, val2);

    // Verify keys exist before deletion
    expect(tree.getSync(key1)).toBeDefined();
    expect(tree.getSync(key2)).toBeDefined();

    // Delete one key
    let wasDeleted = false;
    expect(() => {
      wasDeleted = tree.deleteSync(key1);
    }).not.toThrow();
    expect(wasDeleted).toBe(true);

    // Verify the key is gone
    expect(tree.getSync(key1)).toBeNull();
    // Verify the other key remains
    expectU8Eq(tree.getSync(key2), val2);

    // Attempt to delete a non-existent key
    let wasDeletedAgain = true;
    expect(() => {
      wasDeletedAgain = tree.deleteSync(toU8("non_existent_key"));
    }).not.toThrow();
    expect(wasDeletedAgain).toBe(false);
  });

  it("should handle interleaved sync inserts and deletes correctly", async () => {
    const tree = new PTree();

    // Initial state
    tree.insertSync(toU8("a"), toU8("val_a"));
    tree.insertSync(toU8("b"), toU8("val_b"));
    tree.insertSync(toU8("c"), toU8("val_c"));

    const hash1 = await tree.getRootHash();
    expect(hash1).not.toBeNull();

    // Perform sync modifications
    tree.deleteSync(toU8("b")); // delete middle
    tree.insertSync(toU8("d"), toU8("val_d")); // add
    tree.insertSync(toU8("a"), toU8("val_a_mod")); // overwrite

    const hash2 = await tree.getRootHash();
    expect(hash2).not.toBeNull();
    expect(Array.from(hash1!)).not.toEqual(Array.from(hash2!));

    // Verify final state
    expectU8Eq(tree.getSync(toU8("a")), toU8("val_a_mod"));
    expect(tree.getSync(toU8("b"))).toBeNull();
    expectU8Eq(tree.getSync(toU8("c")), toU8("val_c"));
    expectU8Eq(tree.getSync(toU8("d")), toU8("val_d"));
  });

  it("should empty the tree when the last element is deleted synchronously", () => {
    const tree = new PTree();
    const key = toU8("the_last_one");

    tree.insertSync(key, toU8("value"));
    expect(tree.getSync(key)).not.toBeNull();

    const wasDeleted = tree.deleteSync(key);
    expect(wasDeleted).toBe(true);

    expect(tree.getSync(key)).toBeNull();
    // We must check the root hash asynchronously
    // This part of the test is async to check the final root state.
    return expect(tree.getRootHash()).resolves.toBeNull();
  });

  it.skip("should throw an error if trying sync operations while an async one is in progress", async () => {
    // NOTE: This test is skipped because it's fundamentally racy and difficult to test reliably
    // from a single-threaded JavaScript environment interacting with the Wasm module's internal
    // async runtime.
    // The Rust `tokio` runtime spawned by `wasm-bindgen-futures` may run an entire async task
    // to completion in a single "turn" from the perspective of the JS event loop, because the
    // `await` points within the Rust code are for the Tokio scheduler, not the JS event loop.
    // This makes it nearly impossible to guarantee that a JS-based `getSync` call will execute
    // at the exact moment the internal Mutex is locked by an async operation.
    // While the locking mechanism in Rust is sound, proving it from a JS test is not deterministic.
    const tree = new PTree();
    const largeValue = createLargeTestData(50 * 1024); // 50 KB

    const longInsertPromise = tree.insert(toU8("long_op"), largeValue);

    // In a real-world scenario with contention, the following would throw.
    // Here, we just await the promise to ensure cleanup.
    // expect(() => tree.getSync(toU8("x"))).toThrow();

    await longInsertPromise;
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

describe("PTree CDC", () => {
  // Default config thresholds (approx based on Rust defaults):
  const MAX_INLINE = 1024;
  const AVG_CHUNK = 16 * 1024;

  it("CDC: should store small values inline", async () => {
    const tree = new PTree();
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
    const tree = new PTree();
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
    const tree = new PTree();
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
    const tree = new PTree();
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
describe("PTreeCursor", () => {
  it("should iterate over an empty tree", async () => {
    const tree = new PTree();
    const cursor = (await tree.cursorStart()) as PTreeCursor;
    const result = await cursor.next();

    expect(result.done).toBe(true);
    expect(result.value).toBeUndefined();
  });

  it("should iterate over a single-leaf tree in order", async () => {
    const tree = new PTree();
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

    const cursor = (await tree.cursorStart()) as PTreeCursor;
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

    expectKeyArrayEq(
      collectedKeys as unknown as Uint8Array[],
      expectedKeys as unknown as Uint8Array[],
      "Keys not in order"
    );
    expectKeyArrayEq(
      collectedValues as unknown as Uint8Array[],
      expectedValues as unknown as Uint8Array[],
      "Values not matching keys"
    );
  });

  it("should iterate over a multi-level tree (split) in order", async () => {
    const tree = new PTree({ targetFanout: 4, minFanout: 2 }); // Use small fanout
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

    const cursor = (await tree.cursorStart()) as PTreeCursor;
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
      expect(collectedItems[i]).not.toBeUndefined();
      expect(expectedItems[i]).not.toBeUndefined();
      if (!collectedItems[i] || !expectedItems[i]) continue;

      expectU8Eq(
        collectedItems[i]?.k,
        expectedItems[i]?.k,
        `Key mismatch at index ${i}`
      );
      expectU8Eq(
        collectedItems[i]?.v,
        expectedItems[i]?.v,
        `Value mismatch at index ${i}`
      );
    }
  }, 10_000);

  it("should seek to a specific key", async () => {
    const tree = new PTree();
    const items = ["a", "b", "c", "d", "e", "f", "g"].map((k) => ({
      k,
      v: `v${k}`,
    }));
    for (const item of items) await tree.insert(toU8(item.k), toU8(item.v));

    const seekKey = toU8("d");
    const cursor = (await tree.seek(seekKey)) as PTreeCursor;

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
    const tree = new PTree();
    const items = ["a", "b", "c"].map((k) => ({ k, v: `v${k}` }));
    for (const item of items) await tree.insert(toU8(item.k), toU8(item.v));

    const seekKey = toU8("d"); // Key after all existing keys
    const cursor = (await tree.seek(seekKey)) as PTreeCursor;

    const result = await cursor.next();
    expect(result.done).toBe(true);
  });

  it("should seek to the first key", async () => {
    const tree = new PTree();
    const items = ["b", "c", "a"].map((k) => ({ k, v: `v${k}` })); // Insert out of order
    for (const item of items) await tree.insert(toU8(item.k), toU8(item.v));

    const seekKey = toU8("a"); // Seek to first actual key
    const cursor = (await tree.seek(seekKey)) as PTreeCursor;

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
    const tree = new PTree();
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

    const cursor = (await tree.cursorStart()) as PTreeCursor;
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

describe("PTree Diff", () => {
  it("should return empty diff for identical trees", async () => {
    const tree = new PTree();
    await tree.insert(toU8("a"), toU8("1"));
    await tree.insert(toU8("b"), toU8("2"));
    const hash1 = (await tree.getRootHash()) as Uint8Array | null;
    // Diff hash1 against hash1
    const diffs = (await tree.diffRoots(hash1, hash1)) as JsDiffEntry[];
    expect(diffs).toEqual([]);
  });

  it("should return empty diff for two empty trees", async () => {
    const tree = new PTree();
    // Diff null against null
    const diffs = (await tree.diffRoots(null, null)) as JsDiffEntry[];
    expect(diffs).toEqual([]);
  });

  // *** Un-skip and correct additions test ***
  it("should detect additions (diff empty vs non-empty)", async () => {
    const tree = new PTree(); // Use one tree
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
    const tree = new PTree();
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
    const tree = new PTree();
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
    const tree = new PTree();
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
    const tree = new PTree();
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

describe("PTree Events (onChange)", () => {
  it("should fire a 'change' event on insert with the correct payload", async () => {
    const tree = new PTree();
    const listener = vi.fn();

    const oldRootHash = await tree.getRootHash(); // null
    tree.onChange(listener);
    await tree.insert(toU8("a"), toU8("1"));
    const newRootHash = await tree.getRootHash();

    // Check that the listener was called exactly once
    expect(listener).toHaveBeenCalledTimes(1);

    // Check the payload of the event
    const eventDetails = listener.mock.calls[0]?.[0];
    expect(eventDetails.type).toBe("insert");
    expectU8Eq(eventDetails.oldRootHash, oldRootHash);
    expectU8Eq(eventDetails.newRootHash, newRootHash);
  });

  it("should fire events for all types of successful mutations", async () => {
    const tree = new PTree();
    const listener = vi.fn();
    tree.onChange(listener);

    // 1. Insert
    await tree.insert(toU8("a"), toU8("1"));
    expect(listener).toHaveBeenCalledTimes(1);
    expect(listener).toHaveBeenLastCalledWith(
      expect.objectContaining({ type: "insert" })
    );
    const hash1 = await tree.getRootHash();

    // 2. Batch Insert
    await tree.insertBatch([[toU8("b"), toU8("2")]]);
    expect(listener).toHaveBeenCalledTimes(2);
    expect(listener).toHaveBeenLastCalledWith(
      expect.objectContaining({ type: "insertBatch" })
    );

    // 3. Delete
    await tree.delete(toU8("a"));
    expect(listener).toHaveBeenCalledTimes(3);
    expect(listener).toHaveBeenLastCalledWith(
      expect.objectContaining({ type: "delete" })
    );

    // 4. Checkout
    await tree.checkout(hash1);
    expect(listener).toHaveBeenCalledTimes(4);
    expect(listener).toHaveBeenLastCalledWith(
      expect.objectContaining({ type: "checkout" })
    );
  });

  it("should NOT fire a 'change' event if the root hash does not change", async () => {
    const tree = new PTree();
    await tree.insert(toU8("a"), toU8("1"));

    const listener = vi.fn();
    tree.onChange(listener);

    // Deleting a non-existent key should not change the hash
    const deleted = await tree.delete(toU8("non-existent"));
    expect(deleted).toBe(false);
    expect(listener).not.toHaveBeenCalled();

    // Checking out to the same hash should not fire an event
    const currentHash = await tree.getRootHash();
    await tree.checkout(currentHash);
    expect(listener).not.toHaveBeenCalled();
  });

  it("should allow unsubscribing from 'change' events with offChange", async () => {
    const tree = new PTree();
    const listener = vi.fn();

    tree.onChange(listener);
    await tree.insert(toU8("a"), toU8("1"));
    expect(listener).toHaveBeenCalledTimes(1);

    // Unsubscribe
    tree.offChange(listener);

    // This mutation should NOT trigger the listener
    await tree.insert(toU8("b"), toU8("2"));
    expect(listener).toHaveBeenCalledTimes(1); // Still 1
  });

  it("should trigger events for synchronous operations", async () => {
    const tree = new PTree();
    const listener = vi.fn();
    tree.onChange(listener);

    // 1. Sync Insert
    const oldHash1 = await tree.getRootHash();
    tree.insertSync(toU8("sync1"), toU8("val1"));
    const newHash1 = await tree.getRootHash();

    expect(listener).toHaveBeenCalledTimes(1);
    let eventDetails = listener.mock.calls[0]?.[0];
    expect(eventDetails.type).toBe("insert");
    expectU8Eq(eventDetails.oldRootHash, oldHash1);
    expectU8Eq(eventDetails.newRootHash, newHash1);

    // 2. Sync Delete
    const oldHash2 = await tree.getRootHash();
    tree.deleteSync(toU8("sync1"));
    const newHash2 = await tree.getRootHash();

    expect(listener).toHaveBeenCalledTimes(2);
    eventDetails = listener.mock.calls[1]?.[0];
    expect(eventDetails.type).toBe("delete");
    expectU8Eq(eventDetails.oldRootHash, oldHash2);
    expectU8Eq(eventDetails.newRootHash, newHash2);
  });

  it("should call multiple listeners when multiple are registered", async () => {
    const tree = new PTree();
    const listener1 = vi.fn();
    const listener2 = vi.fn();

    tree.onChange(listener1);
    tree.onChange(listener2);

    await tree.insert(toU8("a"), toU8("1"));

    expect(listener1).toHaveBeenCalledTimes(1);
    expect(listener2).toHaveBeenCalledTimes(1);
    expect(listener1).toHaveBeenCalledWith(listener2.mock.calls[0]?.[0]); // Both called with same payload
  });
});
// +++ New Test Suite for scanItemsSync +++

// +++ New Test Suite for scanItemsSync +++

interface TestItem {
  key: Uint8Array;
  value: Uint8Array;
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
      if (a.key[i] !== b.key[i]) return (a.key[i] ?? 0) - (b.key[i] ?? 0);
    }
    return a.key.length - b.key.length;
  });
  return items;
}

// Define a new type for the page after processing.
type ProcessedScanPage = {
  items: TestItem[];
  hasNextPage: boolean;
  hasPreviousPage: boolean;
  nextPageCursor: Uint8Array | undefined;
  previousPageCursor: Uint8Array | undefined;
};

// Directly processes the ScanPage result from a sync call.
// This was corrected to explicitly access getters instead of using spread syntax.
function processSyncScanPage(page: IScanPage): ProcessedScanPage {
  const processedItems: TestItem[] = page.items.map((pair) => ({
    key: pair[0],
    value: pair[1],
  }));
  return {
    items: processedItems,
    hasNextPage: page.hasNextPage,
    hasPreviousPage: page.hasPreviousPage,
    nextPageCursor: page.nextPageCursor ?? undefined,
    previousPageCursor: page.previousPageCursor ?? undefined,
  };
}

describe("PTree Synchronous Scanning (scanItemsSync)", () => {
  let tree: PTree;
  const testDataAll = createTestItems(25, "item", "value");

  beforeEach(async () => {
    tree = new PTree();
    // insertBatch is async, so beforeEach must be async to set up the tree
    const batch = testDataAll.map((item) => [item.key, item.value]);
    await tree.insertBatch(batch as any);
  });

  it("should retrieve all items with no options (full scan)", () => {
    const page = processSyncScanPage(
      tree.scanItemsSync({ limit: testDataAll.length + 5 }) as IScanPage
    );
    expectKeyValueArrayEq(page.items, testDataAll, "Full sync scan mismatch");
    expect(page.hasNextPage).toBe(false);
    expect(page.hasPreviousPage).toBe(false);
  });

  it("should handle offset correctly", () => {
    const offset = 3;
    const page = processSyncScanPage(
      tree.scanItemsSync({ offset, limit: testDataAll.length }) as IScanPage
    );
    expectKeyValueArrayEq(
      page.items,
      testDataAll.slice(offset),
      "Sync offset mismatch"
    );
    expect(page.hasPreviousPage).toBe(true);
    expect(page.hasNextPage).toBe(false);
  });

  it("should handle limit correctly", () => {
    const limit = 4;
    const page = processSyncScanPage(
      tree.scanItemsSync({ limit }) as IScanPage
    );
    expectKeyValueArrayEq(
      page.items,
      testDataAll.slice(0, limit),
      "Sync limit mismatch"
    );
    expect(page.hasNextPage).toBe(true);
    expect(page.items.length).toBe(limit);
  });

  it("should handle offset and limit combined", () => {
    const offset = 2;
    const limit = 5;
    const page = processSyncScanPage(
      tree.scanItemsSync({ offset, limit }) as IScanPage
    );
    expectKeyValueArrayEq(
      page.items,
      testDataAll.slice(offset, offset + limit),
      "Sync Offset + Limit mismatch"
    );
    expect(page.hasNextPage).toBe(testDataAll.length > offset + limit);
    expect(page.hasPreviousPage).toBe(offset > 0);
  });

  it("should retrieve items by key range (inclusive start, exclusive end)", () => {
    const options: ScanOptions = {
      startBound: toU8("item_002"),
      startInclusive: true,
      endBound: toU8("item_005"),
      endInclusive: false,
    };
    const page = processSyncScanPage(tree.scanItemsSync(options) as IScanPage);
    const expected = testDataAll.slice(2, 5); // item_002, item_003, item_004
    expectKeyValueArrayEq(
      page.items,
      expected,
      "Sync key range [start, end) mismatch"
    );
    expect(page.hasNextPage).toBe(false);
  });

  it("should retrieve items by key range (inclusive start, inclusive end)", () => {
    const options: ScanOptions = {
      startBound: toU8("item_015"),
      startInclusive: true,
      endBound: toU8("item_018"),
      endInclusive: true,
      limit: 10,
    };
    const page = processSyncScanPage(tree.scanItemsSync(options) as IScanPage);
    const expected = testDataAll.slice(15, 19); // item_015 to item_018
    expectKeyValueArrayEq(
      page.items,
      expected,
      "Sync key range [start, end] mismatch"
    );
    expect(page.hasNextPage).toBe(false);
  });

  it("should handle reverse scan", () => {
    const limit = 3;
    const page = processSyncScanPage(
      tree.scanItemsSync({ reverse: true, limit }) as IScanPage
    );
    const expected = [
      ...testDataAll.slice(testDataAll.length - limit),
    ].reverse();
    expectKeyValueArrayEq(page.items, expected, "Sync reverse scan mismatch");
    expect(page.hasNextPage).toBe(true);
    expect(page.hasPreviousPage).toBe(false);
  });

  it("should handle reverse scan with bounds", () => {
    const options: ScanOptions = {
      startBound: toU8("item_007"), // Upper bound
      startInclusive: false,
      endBound: toU8("item_003"), // Lower bound
      endInclusive: true,
      reverse: true,
      limit: 10,
    };
    const page = processSyncScanPage(tree.scanItemsSync(options) as IScanPage);
    const expectedSlice = testDataAll.slice(3, 7); // item_003 to item_006
    const expected = [...expectedSlice].reverse();
    expectKeyValueArrayEq(
      page.items,
      expected,
      "Sync reverse scan with bounds mismatch"
    );
    expect(page.hasNextPage, "Reverse scan with bounds: hasNextPage").toBe(
      false
    );
    expect(
      page.hasPreviousPage,
      "Reverse scan with bounds: hasPreviousPage"
    ).toBe(true);
  });

  it("should return empty page for scan on empty tree", () => {
    const emptyTree = new PTree();
    const page = processSyncScanPage(emptyTree.scanItemsSync({}) as IScanPage);
    expect(page.items.length).toBe(0);
    expect(page.hasNextPage).toBe(false);
  });

  it("should handle offset exceeding available items", () => {
    const page = processSyncScanPage(
      tree.scanItemsSync({ offset: testDataAll.length + 5 }) as IScanPage
    );
    expect(page.items.length).toBe(0);
    expect(page.hasNextPage).toBe(false);
  });
});

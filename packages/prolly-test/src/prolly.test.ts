// packages/prolly-tests/src/prolly.test.ts
import { describe, it, expect, beforeAll } from "vitest";

// Adjust the relative path based on your test file's location
// Might need to configure Vitest/TS paths if resolution fails.
import { WasmProllyTree } from "prolly-wasm";

// Helper to convert strings to Uint8Array for keys/values
const encoder = new TextEncoder();
const toU8 = (s: string): Uint8Array => encoder.encode(s);

// Helper to compare Uint8Arrays
const expectU8Eq = (
  a: Uint8Array | undefined | null,
  b: Uint8Array | undefined | null
) => {
  if (a === undefined || a === null) {
    expect(b).toBeNull(); // Or undefined, depending on JS semantics
    return;
  }
  expect(b).toBeInstanceOf(Uint8Array);
  // Simple comparison for testing, might need more robust for edge cases
  expect(Array.from(a)).toEqual(Array.from(b!));
};

beforeAll(async () => {
  // Initialize the Wasm module once before all tests
  //   await init();
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
});

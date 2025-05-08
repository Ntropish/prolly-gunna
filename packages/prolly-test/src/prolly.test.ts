// packages/prolly-tests/src/prolly.test.ts
import { describe, it, expect, beforeAll } from "vitest";

// Adjust the relative path based on your test file's location
// Might need to configure Vitest/TS paths if resolution fails.
import init, { WasmProllyTree } from "prolly-wasm";

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
  await init();
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

  // Add more tests for edge cases, different key/value types, errors, etc.
  // Test for delete once implemented.
});

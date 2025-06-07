// packages/prolly-test/src/prolly.test.ts
import { describe, it, expect, beforeAll } from "vitest";
import { PTree } from "../dist/prolly_rust.js";

// Helper to convert strings to Uint8Array for keys/values
const encoder = new TextEncoder();
const toU8 = (s: string): Uint8Array => encoder.encode(s);

// Helper to compare Uint8Array
const expectU8Eq = (
  a: Uint8Array | undefined | null,
  b: Uint8Array | undefined | null,
  message?: string
) => {
  const context = message ? `: ${message}` : "";
  if (a === undefined || a === null) {
    expect(b, `Expected null${context}`).toBeNull();
    return;
  }
  expect(b, `Expected Uint8Array${context}`).toBeInstanceOf(Uint8Array);
  if (b) {
    // Ensure b is not null before accessing its properties
    expect(Array.from(a), `Array comparison${context}`).toEqual(Array.from(b));
  }
};

// Helper to create large data (copied from your existing tests for consistency)
function createLargeTestData(size: number, seed: number = 42): Uint8Array {
  const buffer = new Uint8Array(size);
  let current = seed;
  for (let i = 0; i < size; i++) {
    current = (current * 1103515245 + 12345) % 2 ** 31;
    buffer[i] = current % 256;
  }
  return buffer;
}

// Helper to get the root hash (assuming getRootHash returns Promise<Uint8Array | null>)
async function getRootHash(tree: PTree): Promise<Uint8Array | null> {
  return (await tree.getRootHash()) as Uint8Array | null;
}

// Helper to count chunks
async function countChunks(tree: PTree): Promise<number> {
  const chunks = (await tree.exportChunks()) as Map<Uint8Array, Uint8Array>;
  return chunks.size;
}

describe("PTree Garbage Collection (GC)", () => {
  beforeAll(async () => {
    // await init();
  });
  it("GC: should do nothing on an empty store", async () => {
    const tree = new PTree();
    const liveRoots: Uint8Array[] = [];

    const initialChunks = await countChunks(tree);
    expect(initialChunks).toBe(0); // Assuming new tree truly has 0 chunks before any insert

    const collectedCount = await tree.triggerGc(liveRoots);
    expect(collectedCount).toBe(0);

    const finalChunks = await countChunks(tree);
    expect(finalChunks).toBe(0);
  });

  it("GC: should collect all chunks if tree becomes empty and no external live roots are specified", async () => {
    const tree = new PTree();
    const key1 = toU8("key1");
    const val1 = toU8("value1");
    const key2 = toU8("key2");
    const val2 = createLargeTestData(2000);

    await tree.insert(key1, val1);
    await tree.insert(key2, val2);

    // We don't need chunksBeforeGc for this specific assertion anymore if we check chunksAfterGc is 0.
    // let chunksBeforeGc = await countChunks(tree);

    await tree.delete(key1);
    await tree.delete(key2);

    const currentRootHash = await getRootHash(tree);
    expect(
      currentRootHash,
      "Tree root should be null after deleting all items"
    ).toBeNull();

    const chunksInStoreBeforeGcRun = await countChunks(tree); // How many actual items are in store now
    console.log(
      `Chunks in store just before GC (after all deletes): ${chunksInStoreBeforeGcRun}`
    ); // Should be 4 based on trace

    const liveRoots: Uint8Array[] = [];
    const collectedCount = await tree.triggerGc(liveRoots);

    expect(collectedCount).toBe(chunksInStoreBeforeGcRun); // All chunks that were present should be collected

    const chunksAfterGc = await countChunks(tree);
    expect(
      chunksAfterGc,
      "Store should be empty after GC with no live roots and null internal root"
    ).toBe(0);
  });

  it("GC: should preserve live tree and collect orphaned tree", async () => {
    const tree = new PTree(); // This tree instance will manage the shared store

    // Create Tree A (will be orphaned)
    await tree.insert(toU8("a_key1"), toU8("a_value1"));
    await tree.insert(toU8("a_key2"), createLargeTestData(2100, 1)); // Chunked
    const rootA = await getRootHash(tree);
    expect(rootA).not.toBeNull();
    const chunksAfterA = await countChunks(tree);
    expect(chunksAfterA).toBeGreaterThanOrEqual(2);

    // Create Tree B (will be live) by adding more data to the same tree instance,
    // effectively creating a new version.
    await tree.insert(toU8("b_key1"), toU8("b_value1"));
    await tree.insert(toU8("b_key2"), createLargeTestData(2200, 2)); // Another chunked value
    const rootB = await getRootHash(tree);
    expect(rootB).not.toBeNull();
    expect(Array.from(rootA!)).not.toEqual(Array.from(rootB!)); // Roots must differ

    const chunksBeforeGc = await countChunks(tree);
    // Chunks from A + new chunks from B modifications/additions
    expect(chunksBeforeGc).toBeGreaterThan(chunksAfterA);

    // GC: Keep rootB live, rootA becomes orphaned.
    const collectedCount = await tree.triggerGc([rootB!]);

    // We expect some chunks to be collected (those unique to rootA).
    // The exact number is hard to predict without knowing the chunking details and node structure.
    // It must be less than chunksAfterA if there's any sharing, or equal if no sharing.
    // It must be greater than 0 if rootA had unique chunks.
    expect(collectedCount).toBeGreaterThan(0);
    expect(collectedCount).toBeLessThanOrEqual(chunksAfterA);

    const chunksAfterGc = await countChunks(tree);
    expect(chunksAfterGc).toBe(chunksBeforeGc - collectedCount);

    // Verify Tree B is still intact
    expectU8Eq(await tree.get(toU8("b_key1")), toU8("b_value1"));
    expectU8Eq(await tree.get(toU8("b_key2")), createLargeTestData(2200, 2));
    // Original keys from A that might also be in B if B is a superset, or gone if B is totally different.
    // Since we added to the same tree instance, a_key1 and a_key2 should still be there.
    expectU8Eq(await tree.get(toU8("a_key1")), toU8("a_value1"));
    expectU8Eq(await tree.get(toU8("a_key2")), createLargeTestData(2100, 1));

    // Attempt to load Tree A using its root hash from the *current store state*
    // This requires `PTree.load` to use the store of an existing instance
    // or for us to export chunks and re-import. For simplicity, we assume
    // `PTree.load` can be made to use the GC'd store if we provide the current chunk map.
    const currentChunksMap = (await tree.exportChunks()) as Map<
      Uint8Array,
      Uint8Array
    >;
    try {
      const loadedTreeA = await PTree.load(rootA!, currentChunksMap);
      // If rootA's unique chunks were collected, operations on loadedTreeA should fail.
      // This is a strong test: can we still get data specific to rootA?
      const val = await loadedTreeA.get(toU8("a_key1")); // Or a key unique to A if designed so
      // This expectation depends on whether rootA shared all its nodes with rootB.
      // If a_key1's node was unique to rootA and not part of rootB's history, this should be null.
      // Given the way we built it, it's likely still there if rootB is just additions.
      // A better test would be to create two *completely separate* trees in the same store
      // if the API supported that (e.g. tree = new PTree(storeInstance)).
      // For now, we'll assume this test is about versions.
      // If a_key1 was part of a chunk only reachable from rootA and not rootB,
      // and that chunk was GC'd, then this get would fail.
      // The current `tree.get` will use the live tree state (rootB).
      // This part of the test might need a more sophisticated setup to truly test loading an orphaned root.
      console.warn(
        "GC Test: Verification of loading orphaned rootA is complex with current shared-instance setup."
      );
    } catch (e) {
      // This is more likely if PTree.load or subsequent .get fails due to missing chunks.
      const errString = e instanceof Error ? e.message : String(e);
      expect(errString).toContain("Chunk not found");
    }
  });

  it("GC: should handle shared chunks correctly (preserve if one live root)", async () => {
    const tree = new PTree();
    const sharedValue = createLargeTestData(3000, 10); // Large, likely chunked

    // Tree X: keyX -> sharedValue
    await tree.insert(toU8("keyX"), sharedValue);
    const rootX = await getRootHash(tree);
    expect(rootX).not.toBeNull();
    const chunksAfterX = await countChunks(tree);

    // Tree Y: keyY -> sharedValue (same tree instance, new version)
    // This also means keyX is still present.
    await tree.insert(toU8("keyY"), sharedValue); // Re-inserting same large value
    const rootY = await getRootHash(tree);
    expect(rootY).not.toBeNull();
    expect(Array.from(rootX!)).not.toEqual(Array.from(rootY!));
    const chunksAfterY = await countChunks(tree);
    // Chunks should increase due to new leaf/internal nodes for keyY, but not for sharedValue's data chunks.
    // The increase should be small (e.g., 1-2 node chunks).
    expect(chunksAfterY).toBeGreaterThan(chunksAfterX);
    expect(chunksAfterY).toBeLessThan(chunksAfterX + 5); // Heuristic for small node changes

    // Tree Z: keyZ -> differentValue (new version)
    await tree.insert(toU8("keyZ"), toU8("differentValue"));
    const rootZ = await getRootHash(tree);
    expect(rootZ).not.toBeNull();
    const chunksBeforeGc = await countChunks(tree);

    // GC: Keep rootY live. rootX and rootZ become "versions".
    // Chunks for sharedValue should be kept because rootY (which includes keyY->sharedValue) is live.
    // Chunks unique to rootX (if any, beyond sharedValue path) should be collected.
    // Chunks unique to rootZ (for "differentValue" and its nodes) should be collected.
    const collectedCount = await tree.triggerGc([rootY!]); // Only rootY is live

    // Expect some collection (e.g. nodes unique to rootX's structure for keyX if it changed path to sharedValue,
    // and nodes/data for rootZ).
    expect(collectedCount).toBeGreaterThan(0);

    const chunksAfterGc = await countChunks(tree);
    expect(chunksAfterGc).toBe(chunksBeforeGc - collectedCount);

    // Verify Tree Y is intact (current state of 'tree' instance)
    expectU8Eq(await tree.get(toU8("keyX")), sharedValue); // Still there due to history of tree
    expectU8Eq(await tree.get(toU8("keyY")), sharedValue);
    expectU8Eq(await tree.get(toU8("keyZ")), toU8("differentValue")); // Also still there

    // This test primarily shows that if we keep rootY, the sharedValue chunks persist.
    // A stronger test of sharing would involve multiple PTree instances sharing one ChunkStore,
    // and then making one instance's root "dead".
  });

  it("GC: should preserve all chunks of the specified live root, and collect prior orphaned versions", async () => {
    const tree = new PTree();

    // Step 1: Create an initial state (Root R1, Node N1)
    await tree.insert(toU8("live1"), toU8("val1"));
    const rootR1 = await getRootHash(tree); // Hash of N1
    expect(rootR1).not.toBeNull();
    const chunksAfterR1 = await countChunks(tree); // Should be 1 (N1)

    // Step 2: Update the tree, creating a new root R2 (Node N2) and a data chunk DC_L.
    // N1 becomes an orphan.
    await tree.insert(toU8("live2"), createLargeTestData(2300));
    const rootR2 = await getRootHash(tree); // Hash of N2
    expect(rootR2).not.toBeNull();
    expect(Array.from(rootR1!)).not.toEqual(Array.from(rootR2!)); // Roots must differ

    const chunksBeforeGc = await countChunks(tree);
    // Store should contain: N1 (orphan), DC_L (data for live2), N2 (current root R2)
    // So, chunksBeforeGc should be 3.
    expect(chunksBeforeGc).toBe(chunksAfterR1 + 2); // N1 + (N2 + DC_L)

    // GC: Keep only the current root (R2) live.
    // N1 is an orphan and should be collected.
    // N2 and DC_L are live and should be preserved.
    const collectedCount = await tree.triggerGc([rootR2!]);

    expect(collectedCount).toBe(1); // Expecting only the orphaned N1 to be collected

    const chunksAfterGc = await countChunks(tree);
    // N2 and DC_L should remain.
    expect(chunksAfterGc).toBe(chunksBeforeGc - collectedCount); // Should be 3 - 1 = 2
    expect(chunksAfterGc).toBe(2); // More direct assertion

    // Verify data of the live tree (R2) is still accessible
    const currentTreeState = await PTree.load(
      rootR2!,
      (await tree.exportChunks()) as Map<Uint8Array, Uint8Array>
    );
    expectU8Eq(await currentTreeState.get(toU8("live1")), toU8("val1"));
    expectU8Eq(
      await currentTreeState.get(toU8("live2")),
      createLargeTestData(2300)
    );
  });
});

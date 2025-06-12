# Prolly Gunna: A High-Performance Prolly Tree Library

Prolly Gunna is a high-performance, in-memory implementation of a Prolly Tree (Probabilistic B-Tree), written in Rust and compiled to WebAssembly for use in both Node.js and browser environments.

Prolly Trees are content-addressed, persistent data structures that offer powerful features like efficient diffing, history traversal, and structural sharing. This makes them ideal for applications requiring verifiable data, snapshots, and low-cost forks, such as decentralized databases, version control systems, and collaborative applications.

## 🕹️ Demo

[Try them out with the prolly-man web app](https://ntropish.github.io/prolly-man/)

## ✨ Features

- High-Performance Key-Value Store: Fast in-memory operations for get, insert, delete, and insertBatch.
- **Synchronous API**: Provides `getSync`, `insertSync`, and `deleteSync` for use cases where an async context is unavailable.
- Persistent & Immutable: Every operation returns a new, updated version of the tree, leaving the original unchanged. This makes versioning and snapshots trivial.
- Content-Addressed Storage: Tree nodes are identified by the hash of their content, enabling natural data deduplication and integrity checks.
- Efficient Diffing: Quickly compute the differences (additions, deletions, modifications) between any two versions of the tree.
- Garbage Collection: Reclaim memory by safely disposing of data chunks that are no longer referenced by a "live" tree version.
- Rich Querying: Perform full-tree iteration or bounded range scans with support for limits, offsets, and forward/reverse iteration.
- Serialization/Deserialization: Save the complete state of a tree to a single byte array and load it back into memory later.
- Hierarchy Inspection: An advanced API to scan the internal node structure of the tree for debugging and analysis.
- Configurable Chunking: Uses Content-Defined Chunking (CDC) for large values to optimize storage and diffing, with configurable parameters.

## 📦 Installation

`npm install prolly-gunna`

## 📊 Performance Highlights

The following benchmarks illustrate the library's key performance characteristics. Latencies are reported per-operation.

- Read & Iteration Performance

  - Small Value get: ~9.5 µs
  - Large Value get (from chunks): ~21.3 µs
  - Full Tree Scan (per item): ~2.6 µs

- Write & Delete Performance

  - Small Value insert: ~525 µs
  - delete: ~0.6 µs

- Advanced Operations
  - Diff (single change in 5,000 items): ~20 µs
  - Diff (10% change in 5,000 items): ~1.0 ms
- Storage Efficiency
  - Incremental Snapshot Cost: Modifying one item in an 81.80 MB tree required only 17.19 KB of new storage, demonstrating the efficiency of structural sharing.

## 🚀 Usage Examples

First, import the PTree class:

```TypeScript
import { PTree } from "prolly-gunna";

// Helper to convert strings to Uint8Array for keys/values
const toU8 = (s: string): Uint8Array => new TextEncoder().encode(s);
const u8ToString = (arr: Uint8Array): string => new TextDecoder().decode(arr);
```

### Basic Operations (Async)

```TypeScript
// Create a new tree with default settings
const tree = new PTree();

// Or, create a tree with custom fanout settings
const customTree = new PTree({
    targetFanout: 64,
    minFanout: 32,
});


// Insert key-value pairs, mutating the tree
await tree.insert(toU8("hello"), toU8("world"));
await tree.insert(toU8("prolly"), toU8("gunna"));

// Get a value
const value = await tree.get(toU8("hello"));
console.log(u8ToString(value)); // "world"

// Get the root hash to capture the current state
const rootHash = await tree.getRootHash();
console.log("Current root hash:", rootHash);

// Delete a value
const wasDeleted = await tree.delete(toU8("prolly"));
console.log("Was 'prolly' deleted?", wasDeleted); // true

const notFound = await tree.get(toU8("prolly"));
console.log("Value after delete:", notFound); // null

// Use batch insertion for efficiency
const batch = [
    [toU8("batch1"), toU8("val1")],
    [toU8("batch2"), toU8("val2")]
];
await tree.insertBatch(batch);
```

### Synchronous Operations

For use cases where an `async` context is not available or desired. These methods will throw an error if an async operation is currently in progress.

```typescript
const tree = new PTree();

// Insert a value synchronously
tree.insertSync(toU8("sync"), toU8("works!"));

// Get a value synchronously
const syncValue = tree.getSync(toU8("sync"));
console.log(u8ToString(syncValue)); // "works!"

// Delete a value synchronously
const wasDeletedSync = tree.deleteSync(toU8("sync"));
console.log("Was 'sync' deleted?", wasDeletedSync); // true
```

### Versioning and Diffing

Use getRootHash() to capture immutable snapshots of the tree between changes.

```TypeScript
const tree = new PTree();
await tree.insert(toU8("a"), toU8("1"));
await tree.insert(toU8("b"), toU8("2"));

// Capture the root hash of Version 1
const hashV1 = await tree.getRootHash();

// Mutate the tree to create Version 2
await tree.delete(toU8("a"));          // Deletion
await tree.insert(toU8("b"), toU8("2_mod")); // Modification
await tree.insert(toU8("c"), toU8("3"));  // Addition

// Capture the root hash of Version 2
const hashV2 = await tree.getRootHash();

// The `tree` object now represents V2, but `hashV1` still points to the old data.
// We can now diff the two historical versions.
const diffs = await tree.diffRoots(hashV1, hashV2);

console.log(diffs);
/*
[
  { key: Uint8Array[1]{'a'}, leftValue: Uint8Array[1]{'1'}, rightValue: undefined },
  { key: Uint8Array[1]{'b'}, leftValue: Uint8Array[1]{'2'}, rightValue: Uint8Array[5]{'2_mod'} },
  { key: Uint8Array[1]{'c'}, leftValue: undefined, rightValue: Uint8Array[1]{'3'} }
]
*/
```

### Checking out a Previous Version

You can instantly revert the live state of the tree to any previous version using its root hash.

```typescript
const tree = new PTree();
await tree.insert(toU8("a"), toU8("1"));
const hashV1 = await tree.getRootHash();

await tree.insert(toU8("b"), toU8("2"));
const hashV2 = await tree.getRootHash();

// The tree is currently at version 2
console.log(u8ToString(await tree.get(toU8("b")))); // "2"

// Checkout version 1
await tree.checkout(hashV1);

// The tree is now in the state of version 1
console.log(await tree.get(toU8("b"))); // null
console.log(u8ToString(await tree.get(toU8("a")))); // "1"
```

### Scanning and Iteration

Efficiently query ranges of data with powerful scanning options.

```TypeScript

const tree = new PTree();
// Insert 20 items (key_00, key_01, ..., key_19)
for (let i = 0; i < 20; i++) {
  const key = toU8(`key_${String(i).padStart(2, "0")}`);
  const val = toU8(`val_${i}`);
  await tree.insert(key, val);
}

// --- Example 1: Paginated Scan ---
const pageSize = 5;
const page1 = await tree.scanItems({ limit: pageSize });

console.log(`Page 1 has ${page1.items.length} items.`);
console.log(`Has next page? ${page1.hasNextPage}`); // true

// --- Example 2: Bounded Range Scan ---
const page2 = await tree.scanItems({
  startBound: toU8("key_05"), // Start at key_05 (inclusive)
  endBound: toU8("key_10"),   // End before key_10 (exclusive)
});

console.log("Items between key_05 and key_10:");
page2.items.forEach(([key, value]) => {
    console.log(`  ${u8ToString(key)} -> ${u8ToString(value)}`);
});

// --- Example 3: Reverse Scan ---
const lastThreeItems = await tree.scanItems({
    reverse: true,
    limit: 3
});
console.log("Last three items in reverse order:");
lastThreeItems.items.forEach(([key, value]) => {
    console.log(`  ${u8ToString(key)} -> ${u8ToString(value)}`);
});
```

### Saving and Loading

Persist the entire tree to a byte array and load it back later.

```TypeScript

const tree = new PTree();
await tree.insert(toU8("persist"), toU8("this tree"));

// Save the tree to a byte array
const fileBytes = await tree.saveTreeToFileBytes("My saved tree");

// ... later, in another context ...

// Load the tree from the byte array
const loadedTree = await PTree.loadTreeFromFileBytes(fileBytes);

const value = await loadedTree.get(toU8("persist"));
console.log(u8ToString(value)); // "this tree"
```

### Garbage Collection

Reclaim memory from old, unreferenced versions of the tree.

```TypeScript
const tree = new PTree();

// Create Version 1
await tree.insert(toU8("a"), toU8("1"));
const hashV1 = await tree.getRootHash(); // Snapshot of V1

// Create Version 2
await tree.insert(toU8("b"), toU8("2"));
const hashV2 = await tree.getRootHash(); // Snapshot of V2

// Mutate again, creating Version 3. hashV2 is now an older, orphaned snapshot.
await tree.insert(toU8("c"), toU8("3"));
const hashV3 = await tree.getRootHash();

// The store now contains chunks for V1, V2, and V3.
// If we only care about V1 and the current state (V3), we can GC anything
// that is unique to V2.
const collectedCount = await tree.triggerGc([hashV1, hashV3]);

console.log(`Garbage collected ${collectedCount} chunks.`);
```

## 📖 API Reference

`PTree`

The main class for interacting with a Prolly Tree.

`new PTree(options?: TreeConfigOptions)`

Creates a new, empty tree. An optional options object can be provided to customize tree parameters.

```typescript
interface TreeConfigOptions {
  targetFanout?: number;
  minFanout?: number;
  cdcMinSize?: number;
  cdcAvgSize?: number;
  cdcMaxSize?: number;
  maxInlineValueSize?: number;
}
```

`static load(rootHash: Uint8Array | null, chunks: Map<Uint8Array, Uint8Array>, config?: TreeConfigOptions): Promise<PTree>`

Loads a tree from its root hash and a map of its constituent data chunks.

`get(key: Uint8Array): Promise<Uint8Array | null>`

Retrieves the value associated with a key. Returns null if the key is not found.

`getSync(key: Uint8Array): Uint8Array | null`

Synchronously retrieves the value for a key. Returns `null` if not found. Throws if an async operation holds the tree lock.

`insert(key: Uint8Array, value: Uint8Array): Promise<void>`

Inserts or updates a key-value pair.

`insertBatch(items: [Uint8Array, Uint8Array][]): Promise<void>`

Inserts an array of key-value pairs efficiently.

`insertSync(key: Uint8Array, value: Uint8Array): void`

Synchronously inserts or updates a key-value pair. Throws if an async operation holds the tree lock.

`delete(key: Uint8Array): Promise<boolean>`

Deletes a key-value pair. Returns true if the key was found and deleted.

`deleteSync(key: Uint8Array): boolean`

Synchronously deletes a key-value pair. Returns `true` if the key was found and deleted. Throws if an async operation holds the tree lock.

`checkout(hash: Uint8Array | null): Promise<void>`

Resets the tree's root to a specific hash, effectively checking out a previous version. Pass null to reset to an empty tree.

`getRootHash(): Promise<Uint8Array | null>`

Returns the root hash of the current tree state.

`scanItems(options: ScanOptions): Promise<ScanPage>`

Performs a query over a range of keys.

`ScanOptions: { startBound, endBound, startInclusive, endInclusive, reverse, offset, limit }
diffRoots(rootA: Uint8Array | null, rootB: Uint8Array | null): Promise<DiffEntry[]>`

Computes the differences between two tree versions identified by their root hashes.

`triggerGc(liveHashes: Uint8Array[]): Promise<number>`

Performs garbage collection, deleting any chunks not reachable from the provided set of liveHashes. Returns the number of chunks collected.

`saveTreeToFileBytes(description?: string): Promise<Uint8Array>`

Serializes the entire tree (root hash, config, and all necessary chunks) into a single byte array for persistent storage.

`static loadTreeFromFileBytes(fileBytes: Uint8Array): Promise<PTree>`

Deserializes a tree from a byte array created by saveTreeToFileBytes.

`hierarchyScan(options?: HierarchyScanOptions): Promise<HierarchyScanPageResult>`

An advanced tool to inspect the internal node and entry structure of the tree. Useful for debugging and analysis.

`PTreeCursor`

An iterator for traversing the tree's key-value pairs.

`tree.cursorStart(): Promise<PTreeCursor>`

Creates a cursor positioned at the beginning of the tree.

`tree.seek(key: Uint8Array): Promise<PTreeCursor>`

Creates a cursor positioned at the first key that is greater than or equal to the given key.

`cursor.next(): Promise<{ done: boolean; value?: [Uint8Array, Uint8Array] }>`

Advances the cursor to the next item, following the standard JavaScript iterator protocol.

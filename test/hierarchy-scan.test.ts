// In packages/prolly-test/src/hierarchy-scan.test.ts

import { describe, it, expect, beforeEach } from "vitest"; // Removed beforeAll as it wasn't strictly used for WASM init here
import {
  PTree,
  HierarchyScanOptions,
  HierarchyItem,
} from "../dist/node/prolly_rust.js"; // Removed initSync, assuming global or other setup
// Updated import to use functions from the provided utils.ts
import { toU8, u8ToString, formatU8Array, expectU8Eq } from "./lib/utils";

// Assuming WASM initialization is handled globally or in a dedicated setup file for your test environment.

describe("ProllyTree Hierarchy Scan", () => {
  let tree: PTree;

  beforeEach(async () => {
    tree = new PTree();
  });

  it("should return an empty array for an empty tree", async () => {
    const options: HierarchyScanOptions = {};
    const result = await tree.hierarchyScan(options);
    expect(result.items).toEqual([]);
    expect(result.hasNextPage).toBe(false);
    expect(result.nextPageCursorToken).toBeUndefined();
  });

  it("should scan a single leaf node tree correctly", async () => {
    await tree.insert(toU8("key1"), toU8("value1"));
    const rootHash = await tree.commit();
    expect(rootHash).toBeDefined();
    if (!rootHash) throw new Error("Root hash is null after commit");

    const options: HierarchyScanOptions = {};
    const result = await tree.hierarchyScan(options);

    expect(result.items.length).toBe(2); // Node item + LeafEntry item

    const nodeItem = result.items.find(
      (item) => item.type === "Node"
    ) as Extract<HierarchyItem, { type: "Node" }>;
    expect(nodeItem).toBeDefined();
    if (nodeItem) {
      expect(nodeItem.isLeaf).toBe(true);
      expect(nodeItem.level).toBe(0);
      expect(nodeItem.numEntries).toBe(1);
      expectU8Eq(
        nodeItem.hash,
        rootHash,
        "NodeItem hash should match rootHash"
      );
      expect(nodeItem.pathIndices).toEqual([]);
    }

    const leafEntryItem = result.items.find(
      (item) => item.type === "LeafEntry"
    ) as Extract<HierarchyItem, { type: "LeafEntry" }>;
    expect(leafEntryItem).toBeDefined();
    if (leafEntryItem) {
      expectU8Eq(
        leafEntryItem.parentHash,
        rootHash,
        "LeafEntryItem parentHash should match rootHash"
      );
      expect(leafEntryItem.entryIndex).toBe(0);
      expectU8Eq(leafEntryItem.key, toU8("key1"), "LeafEntryItem key mismatch");
      expect(leafEntryItem.valueReprType).toBe("Inline");
      expect(leafEntryItem.valueSize).toBe(toU8("value1").length);
    }
  });

  it("should scan a tree with one internal node and two leaf children (small fanout)", async () => {
    const treeWithSmallFanout = await PTree.newWithConfig(2, 1); // (target, min)

    await treeWithSmallFanout.insert(toU8("key00"), toU8("val00"));
    await treeWithSmallFanout.insert(toU8("key01"), toU8("val01"));
    await treeWithSmallFanout.insert(toU8("key02"), toU8("val02"));

    const rootHash = await treeWithSmallFanout.commit();
    expect(rootHash).toBeDefined();
    if (!rootHash) throw new Error("Root hash is null after commit");

    const result = await treeWithSmallFanout.hierarchyScan({});

    // Optional debug logging:
    // console.log(JSON.stringify(result.items.map(item => ({
    //   ...item,
    //   hash: item.hash ? formatU8Array(item.hash) : undefined,
    //   parentHash: item.parentHash ? formatU8Array(item.parentHash) : undefined,
    //   childHash: item.childHash ? formatU8Array(item.childHash) : undefined,
    //   key: 'key' in item && item.key ? u8ToString(item.key) : undefined,
    //   boundaryKey: 'boundaryKey' in item && item.boundaryKey ? u8ToString(item.boundaryKey) : undefined
    // })), null, 2));

    const rootNodeItem = result.items.find(
      (item) => item.type === "Node" && item.level === 1
    ) as Extract<HierarchyItem, { type: "Node" }>;
    expect(rootNodeItem).toBeDefined();
    if (rootNodeItem) {
      expect(rootNodeItem.isLeaf).toBe(false);
      expect(rootNodeItem.numEntries).toBe(2);
      expectU8Eq(
        rootNodeItem.hash,
        rootHash,
        "Internal root node hash mismatch"
      );
    }

    const internalEntries = result.items.filter(
      (item) => item.type === "InternalEntry"
    ) as Extract<HierarchyItem, { type: "InternalEntry" }>[];
    expect(internalEntries.length).toBe(2);
    internalEntries.forEach((entry) => {
      if (rootNodeItem)
        expectU8Eq(
          entry.parentHash,
          rootNodeItem.hash,
          "InternalEntry parentHash mismatch"
        );
    });

    const leafNodeItems = result.items.filter(
      (item) => item.type === "Node" && item.isLeaf === true
    ) as Extract<HierarchyItem, { type: "Node" }>[];
    expect(leafNodeItems.length).toBe(2);

    const leafDataEntries = result.items.filter(
      (item) => item.type === "LeafEntry"
    ) as Extract<HierarchyItem, { type: "LeafEntry" }>[];
    expect(leafDataEntries.length).toBe(3);

    const firstLeafNode = leafNodeItems[0];
    if (firstLeafNode) {
      expect(firstLeafNode.pathIndices.length).toBe(1);
    }
  });

  it("should respect maxDepth option", async () => {
    const treeWithDepth = await PTree.newWithConfig(2, 1);
    await treeWithDepth.insert(toU8("a"), toU8("1"));
    await treeWithDepth.insert(toU8("b"), toU8("2"));
    await treeWithDepth.insert(toU8("c"), toU8("3"));

    let result = await treeWithDepth.hierarchyScan({ maxDepth: 0 });
    const rootNode = result.items.find(
      (item) => item.type === "Node" && item.level === 1
    ) as Extract<HierarchyItem, { type: "Node" }>;
    // Root node (level 1) should be present with maxDepth: 0
    expect(rootNode).toBeDefined();

    // No leaf nodes (level 0) should be present with maxDepth: 0
    const deeperOrLeafNodes = result.items.filter(
      (item) => item.type === "Node" && item.level < 1
    );
    expect(deeperOrLeafNodes.length).toBe(0);

    result = await treeWithDepth.hierarchyScan({ maxDepth: 1 });
    // Leaf nodes (level 0) should be present with maxDepth: 1
    const hasLevel0Nodes = result.items.some(
      (item) => item.type === "Node" && item.level === 0
    );
    expect(hasLevel0Nodes).toBe(true);
    // Root node (level 1) should be present with maxDepth: 1
    const hasLevel1Node = result.items.some(
      (item) => item.type === "Node" && item.level === 1
    );
    expect(hasLevel1Node).toBe(true);

    // Nodes deeper than level 1 should not be present with maxDepth: 1
    const hasNodesDeeperThan1 = result.items.some(
      (item) => item.type === "Node" && item.level > 1
    );
    expect(hasNodesDeeperThan1).toBe(false);
  });

  it("should respect limit option", async () => {
    const treeWithLimit = await PTree.newWithConfig(2, 1);
    await treeWithLimit.insert(toU8("k1"), toU8("v1"));
    await treeWithLimit.insert(toU8("k2"), toU8("v2"));
    await treeWithLimit.insert(toU8("k3"), toU8("v3"));

    const fullResult = await treeWithLimit.hierarchyScan({});
    const totalItems = fullResult.items.length;

    if (totalItems > 3) {
      const result = await treeWithLimit.hierarchyScan({ limit: 3 });
      expect(result.items.length).toBe(3);
      expect(result.hasNextPage).toBe(true);
    } else {
      const result = await treeWithLimit.hierarchyScan({ limit: 3 });
      expect(result.items.length).toBe(totalItems);
      expect(result.hasNextPage).toBe(false);
    }
  });
});

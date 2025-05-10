import React, { useState, useCallback } from "react";
import { WasmProllyTreeCursor } from "prolly-wasm";
import { type TreeState, useAppStore } from "@/useAppStore"; // Assuming useAppStore exports TreeState
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "./ui/card";
import { Button } from "./ui/button";
import { Input } from "./ui/input";
import { Textarea } from "./ui/textarea";
import { ScrollArea } from "./ui/scroll-area";

import hexToUint8Array from "@/utils/hexToUint8Array";
import u8ToHex from "@/utils/u8ToHex";

const encoder = new TextEncoder();
const toU8 = (s: string): Uint8Array => encoder.encode(s);
const decoder = new TextDecoder();
const toString = (u8: Uint8Array | null | undefined): string => {
  if (u8 === null || u8 === undefined) return "";
  return decoder.decode(u8);
};

interface TreeInterfaceProps {
  treeState: TreeState;
}

export function TreeInterface({ treeState }: TreeInterfaceProps) {
  const updateTreeState = useAppStore((state) => state.updateTreeState);
  const addTree = useAppStore((state) => state.addTree);

  // Local state for inputs within this specific tree interface
  const [insertKey, setInsertKey] = useState("");
  const [insertValue, setInsertValue] = useState("");
  const [getKey, setGetKey] = useState("");
  const [deleteKey, setDeleteKey] = useState("");
  const [diffHash1, setDiffHash1] = useState("");
  const [diffHash2, setDiffHash2] = useState("");
  const [gcLiveHashes, setGcLiveHashes] = useState("");

  const updateCurrentTreeState = useCallback(
    (updates: Partial<Omit<TreeState, "id" | "tree">>) => {
      updateTreeState(treeState.id, updates);
    },
    [treeState.id, updateTreeState]
  );

  const refreshRootHash = useCallback(async () => {
    try {
      const rh = await treeState.tree.getRootHash();
      updateCurrentTreeState({ rootHash: u8ToHex(rh), lastError: null });
    } catch (e: any) {
      updateCurrentTreeState({ lastError: e.message });
    }
  }, [treeState.tree, updateCurrentTreeState]);

  const handleInsert = async () => {
    if (!insertKey) return;
    try {
      await treeState.tree.insert(toU8(insertKey), toU8(insertValue));
      await refreshRootHash();
      setInsertKey("");
      setInsertValue("");
      updateCurrentTreeState({
        lastValue: "Insert successful",
        lastError: null,
      });
    } catch (e: any) {
      updateCurrentTreeState({ lastError: e.message });
    }
  };

  const handleGet = async () => {
    if (!getKey) return;
    try {
      const value = await treeState.tree.get(toU8(getKey));
      updateCurrentTreeState({
        lastValue: value ? toString(value) : "null (not found)",
        lastError: null,
      });
    } catch (e: any) {
      updateCurrentTreeState({ lastError: e.message, lastValue: null });
    }
  };

  const handleDelete = async () => {
    if (!deleteKey) return;
    try {
      const deleted = await treeState.tree.delete(toU8(deleteKey));
      await refreshRootHash();
      updateCurrentTreeState({
        lastValue: deleted
          ? "Delete successful"
          : "Delete failed (key not found)",
        lastError: null,
      });
      setDeleteKey("");
    } catch (e: any) {
      updateCurrentTreeState({ lastError: e.message });
    }
  };

  const handleListItems = async () => {
    const fetchedItems: { key: string; value: string }[] = [];
    try {
      const cursor: WasmProllyTreeCursor = await treeState.tree.cursorStart();
      while (true) {
        const result = await cursor.next();
        if (result.done) break;
        if (result.value) {
          const [keyU8, valueU8] = result.value;
          fetchedItems.push({
            key: toString(keyU8),
            value: toString(valueU8),
          });
        }
      }
      updateCurrentTreeState({ items: fetchedItems, lastError: null });
    } catch (e: any) {
      updateCurrentTreeState({ items: [], lastError: e.message });
    }
  };

  const handleExportChunks = async () => {
    try {
      const chunkMap = await treeState.tree.exportChunks();
      const exportedChunks: { hash: string; size: number }[] = [];
      chunkMap.forEach((value: Uint8Array, key: Uint8Array) => {
        exportedChunks.push({ hash: u8ToHex(key), size: value.length });
      });
      updateCurrentTreeState({ chunks: exportedChunks, lastError: null });
    } catch (e: any) {
      updateCurrentTreeState({ chunks: [], lastError: e.message });
    }
  };

  const handleDiff = async () => {
    try {
      const h1 = hexToUint8Array(diffHash1);
      const h2 = hexToUint8Array(diffHash2);

      console.log("Diffing hashes:", h1, h2);
      const diffEntries = await treeState.tree.diffRoots(h1, h2);
      console.log("Diff entries:", diffEntries);
      const formattedDiffs = diffEntries.map((entry: any) => ({
        key: toString(entry.key),
        left: entry.leftValue ? toString(entry.leftValue) : undefined,
        right: entry.rightValue ? toString(entry.rightValue) : undefined,
      }));
      console.log("Diff result:", formattedDiffs);
      updateCurrentTreeState({ diffResult: formattedDiffs, lastError: null });
    } catch (e: any) {
      console.error("Diff error:", e);
      updateCurrentTreeState({ diffResult: [], lastError: e.message });
    }
  };

  const handleGc = async () => {
    try {
      const liveHashesArray = gcLiveHashes
        .split(",")
        .map((h) => h.trim())
        .filter((h) => h.length === 64) // Blake3 hash hex string length
        .map((h) => Uint8Array.from(Buffer.from(h, "hex")));

      const collectedCount = await treeState.tree.triggerGc(liveHashesArray);
      updateCurrentTreeState({
        gcCollectedCount: collectedCount,
        lastError: null,
      });
      await handleExportChunks(); // Refresh chunk list after GC
    } catch (e: any) {
      updateCurrentTreeState({ gcCollectedCount: null, lastError: e.message });
    }
  };

  return (
    <Card className="w-full">
      <CardHeader>
        <CardTitle>Tree ID: {treeState.id}</CardTitle>
        <CardDescription>
          Root Hash: {treeState.rootHash || "N/A (Empty Tree)"}
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-6">
        {treeState.lastError && (
          <p className="text-red-500">Error: {treeState.lastError}</p>
        )}
        {treeState.lastValue && (
          <p className="text-green-500">Result: {treeState.lastValue}</p>
        )}

        {/* Insert Operation */}
        <div className="space-y-2">
          <h3 className="font-semibold">Insert/Update Key-Value</h3>
          <div className="flex gap-2">
            <Input
              placeholder="Key"
              value={insertKey}
              onChange={(e) => setInsertKey(e.target.value)}
            />
            <Input
              placeholder="Value"
              value={insertValue}
              onChange={(e) => setInsertValue(e.target.value)}
            />
            <Button onClick={handleInsert} disabled={!insertKey}>
              Insert
            </Button>
          </div>
        </div>

        {/* Get Operation */}
        <div className="space-y-2">
          <h3 className="font-semibold">Get Value</h3>
          <div className="flex gap-2">
            <Input
              placeholder="Key"
              value={getKey}
              onChange={(e) => setGetKey(e.target.value)}
            />
            <Button onClick={handleGet} disabled={!getKey}>
              Get
            </Button>
          </div>
        </div>

        {/* Delete Operation */}
        <div className="space-y-2">
          <h3 className="font-semibold">Delete Key</h3>
          <div className="flex gap-2">
            <Input
              placeholder="Key"
              value={deleteKey}
              onChange={(e) => setDeleteKey(e.target.value)}
            />
            <Button
              onClick={handleDelete}
              variant="destructive"
              disabled={!deleteKey}
            >
              Delete
            </Button>
          </div>
        </div>

        {/* List Items */}
        <div className="space-y-2">
          <h3 className="font-semibold">
            All Items ({treeState.items.length})
          </h3>
          <Button onClick={handleListItems}>List Items</Button>
          {treeState.items.length > 0 && (
            <ScrollArea className="h-40 w-full rounded-md border p-2">
              <pre className="text-xs text-left">
                {treeState.items
                  .map(
                    (item) =>
                      `Key: ${item.key}\nValue: ${item.value}\n----------`
                  )
                  .join("\n")}
              </pre>
            </ScrollArea>
          )}
        </div>

        {/* Export Chunks */}
        <div className="space-y-2">
          <h3 className="font-semibold">
            Stored Chunks ({treeState.chunks.length})
          </h3>
          <Button onClick={handleExportChunks}>Show Chunks</Button>
          {treeState.chunks.length > 0 && (
            <ScrollArea className="h-40 w-full rounded-md border p-2">
              <pre className="text-xs text-left">
                {treeState.chunks
                  .map((chunk) => `Hash: ${chunk.hash} (Size: ${chunk.size} B)`)
                  .join("\n")}
              </pre>
            </ScrollArea>
          )}
        </div>

        {/* Diff Trees */}
        <div className="space-y-2">
          <h3 className="font-semibold">
            Diff Trees (using this tree's store)
          </h3>
          <div className="flex flex-col gap-2">
            <Input
              placeholder="Root Hash 1 (hex, optional)"
              value={diffHash1}
              onChange={(e) => setDiffHash1(e.target.value)}
            />
            <Input
              placeholder="Root Hash 2 (hex, optional)"
              value={diffHash2}
              onChange={(e) => setDiffHash2(e.target.value)}
            />
            <Button onClick={handleDiff}>Diff</Button>
          </div>
          {treeState.diffResult.length > 0 && (
            <ScrollArea className="h-40 w-full rounded-md border p-2 mt-2">
              <pre className="text-xs text-left">
                {treeState.diffResult
                  .map(
                    (d) =>
                      `Key: ${d.key}\n` +
                      `  Left: ${d.left ?? "N/A"}\n` +
                      `  Right: ${d.right ?? "N/A"}\n` +
                      `----------`
                  )
                  .join("\n")}
              </pre>
            </ScrollArea>
          )}
        </div>

        {/* Garbage Collection */}
        <div className="space-y-2">
          <h3 className="font-semibold">Garbage Collection</h3>
          <Textarea
            placeholder="Live Root Hashes (comma-separated hex strings)"
            value={gcLiveHashes}
            onChange={(e) => setGcLiveHashes(e.target.value)}
            rows={2}
          />
          <Button onClick={handleGc}>Trigger GC</Button>
          {treeState.gcCollectedCount !== null && (
            <p>Chunks collected: {treeState.gcCollectedCount}</p>
          )}
        </div>
      </CardContent>
      <CardFooter>
        <Button onClick={refreshRootHash} variant="outline">
          Refresh Root Hash
        </Button>
      </CardFooter>
    </Card>
  );
}

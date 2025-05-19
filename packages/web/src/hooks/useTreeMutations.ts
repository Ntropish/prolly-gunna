import { useMutation, useQueryClient } from "@tanstack/react-query";
import { type WasmProllyTree, type WasmProllyTreeCursor } from "prolly-wasm";
import { useAppStore, type TreeState } from "@/useAppStore"; // Added TreeState for diffResult typing
import { toU8, u8ToHex, u8ToString, hexToU8 } from "@/lib/prollyUtils"; // Added hexToU8
import { toast } from "sonner";
import type { ScanArgsWasm, ScanPageWasm } from "@/lib/types";

// Common interface for mutation arguments that include tree context
interface BaseTreeMutationArgs {
  treeId: string;
  tree: WasmProllyTree;
}

// --- Insert Item Mutation ---
interface InsertItemArgs extends BaseTreeMutationArgs {
  key: string;
  value: string;

  /**
   * Matches the structure of ScanArgs in Rust for sending to Wasm.
   * Optional fields can be omitted or explicitly set to undefined.
   */
}

export function useInsertItemMutation() {
  const { updateTreeState } = useAppStore();
  return useMutation({
    mutationFn: async (args: InsertItemArgs) => {
      if (!args.key) throw new Error("Insert key cannot be empty.");
      await args.tree.insert(toU8(args.key), toU8(args.value));
      const newRootHashU8 = await args.tree.getRootHash();
      return {
        treeId: args.treeId,
        newRootHash: u8ToHex(newRootHashU8),
        insertedKey: args.key,
      };
    },
    onSuccess: (data) => {
      updateTreeState(data.treeId, {
        rootHash: data.newRootHash,
        lastError: null,
      });
      toast.success(`Item "${data.insertedKey}" inserted successfully.`);
    },
    onError: (error: Error, variables) => {
      updateTreeState(variables.treeId, { lastError: error.message });
      toast.error(`Insert failed for "${variables.key}": ${error.message}`);
    },
  });
}

// --- Get Item Mutation ---
// ... (existing useGetItemMutation)
interface GetItemArgs extends BaseTreeMutationArgs {
  key: string;
}
export function useGetItemMutation() {
  const { updateTreeState } = useAppStore();
  return useMutation({
    mutationFn: async (args: GetItemArgs) => {
      if (!args.key) throw new Error("Get key cannot be empty.");
      const valueU8 = await args.tree.get(toU8(args.key));
      return {
        treeId: args.treeId,
        key: args.key,
        value: valueU8 ? u8ToString(valueU8) : null,
      };
    },
    onSuccess: (data) => {
      const displayValue =
        data.value === null ? "null (not found)" : data.value;
      updateTreeState(data.treeId, {
        lastValue: displayValue,
        lastError: null,
      });
      toast.success(`Value for "${data.key}": ${displayValue}`);
    },
    onError: (error: Error, variables) => {
      updateTreeState(variables.treeId, {
        lastError: error.message,
        lastValue: null,
      });
      toast.error(`Get failed for "${variables.key}": ${error.message}`);
    },
  });
}

// --- Delete Item Mutation ---
// ... (existing useDeleteItemMutation)
interface DeleteItemArgs extends BaseTreeMutationArgs {
  key: string;
}
export function useDeleteItemMutation() {
  const { updateTreeState } = useAppStore();
  return useMutation({
    mutationFn: async (args: DeleteItemArgs) => {
      if (!args.key) throw new Error("Delete key cannot be empty.");
      const wasDeleted = await args.tree.delete(toU8(args.key));
      const newRootHashU8 = await args.tree.getRootHash();
      return {
        treeId: args.treeId,
        newRootHash: u8ToHex(newRootHashU8),
        deletedKey: args.key,
        wasDeleted,
      };
    },
    onSuccess: (data) => {
      updateTreeState(data.treeId, {
        rootHash: data.newRootHash,
        lastError: null,
      });
      if (data.wasDeleted) {
        toast.success(`Item "${data.deletedKey}" deleted successfully.`);
      } else {
        toast.error(`Item "${data.deletedKey}" not found for deletion.`);
      }
    },
    onError: (error: Error, variables) => {
      updateTreeState(variables.treeId, { lastError: error.message });
      toast.error(`Delete failed for "${variables.key}": ${error.message}`);
    },
  });
}

// --- List Items Mutation ---
// ... (existing useListItemsMutation)
export function useListItemsMutation() {
  const { updateTreeState } = useAppStore();
  return useMutation({
    mutationFn: async (args: BaseTreeMutationArgs) => {
      const fetchedItems: { key: string; value: string }[] = [];
      const cursor: WasmProllyTreeCursor = await args.tree.cursorStart();
      while (true) {
        const result: { done: boolean; value?: [Uint8Array, Uint8Array] } =
          await cursor.next();
        if (result.done) break;
        if (result.value) {
          const [keyU8, valueU8] = result.value;
          fetchedItems.push({
            key: u8ToString(keyU8),
            value: u8ToString(valueU8),
          });
        }
      }
      return { treeId: args.treeId, items: fetchedItems };
    },
    onSuccess: (data) => {
      updateTreeState(data.treeId, { items: data.items, lastError: null });
      toast.success(`Listed ${data.items.length} items.`);
    },
    onError: (error: Error, variables) => {
      updateTreeState(variables.treeId, {
        items: [],
        lastError: `Failed to list items: ${error.message}`,
      });
      toast.error(`Failed to list items: ${error.message}`);
    },
  });
}

// --- Export Chunks Mutation ---
// ... (existing useExportChunksMutation)
export function useExportChunksMutation() {
  const { updateTreeState } = useAppStore();
  return useMutation({
    mutationFn: async (args: BaseTreeMutationArgs) => {
      const chunkMap = (await args.tree.exportChunks()) as Map<
        Uint8Array,
        Uint8Array
      >;
      const exportedChunks: { hash: string; size: number }[] = [];
      for (const [keyU8, valueU8] of chunkMap.entries()) {
        exportedChunks.push({ hash: u8ToHex(keyU8), size: valueU8.length });
      }
      return { treeId: args.treeId, chunks: exportedChunks };
    },
    onSuccess: (data) => {
      updateTreeState(data.treeId, { chunks: data.chunks, lastError: null });
      toast.success(`Exported ${data.chunks.length} chunks.`);
    },
    onError: (error: Error, variables) => {
      updateTreeState(variables.treeId, {
        chunks: [],
        lastError: `Failed to export chunks: ${error.message}`,
      });
      toast.error(`Failed to export chunks: ${error.message}`);
    },
  });
}

// --- Diff Trees Mutation ---
interface DiffTreesArgs extends BaseTreeMutationArgs {
  hash1Hex: string; // Root Hash 1 (hex, optional, empty string for null)
  hash2Hex: string; // Root Hash 2 (hex, optional, empty string for null)
}
// Define the structure of a single diff entry as returned by Wasm
interface WasmDiffEntry {
  key: Uint8Array;
  leftValue?: Uint8Array;
  rightValue?: Uint8Array;
}
export function useDiffTreesMutation() {
  const { updateTreeState } = useAppStore();
  return useMutation({
    mutationFn: async (args: DiffTreesArgs) => {
      const h1U8 = args.hash1Hex.trim() ? hexToU8(args.hash1Hex.trim()) : null;
      const h2U8 = args.hash2Hex.trim() ? hexToU8(args.hash2Hex.trim()) : null;

      if (args.hash1Hex.trim() && !h1U8)
        throw new Error(`Invalid hex string for Root Hash 1: ${args.hash1Hex}`);
      if (args.hash2Hex.trim() && !h2U8)
        throw new Error(`Invalid hex string for Root Hash 2: ${args.hash2Hex}`);

      // The Wasm diffRoots function returns a JsArray of JsObjects.
      const diffEntriesJs = (await args.tree.diffRoots(h1U8, h2U8)) as any[]; // Cast to any[] for iteration

      const formattedDiffs: TreeState["diffResult"] = diffEntriesJs.map(
        (entry: WasmDiffEntry) => ({
          key: u8ToString(entry.key),
          left: entry.leftValue ? u8ToString(entry.leftValue) : undefined,
          right: entry.rightValue ? u8ToString(entry.rightValue) : undefined,
        })
      );
      return { treeId: args.treeId, diffResult: formattedDiffs };
    },
    onSuccess: (data) => {
      updateTreeState(data.treeId, {
        diffResult: data.diffResult,
        lastError: null,
      });
      toast.success(
        `Diff computed with ${data.diffResult.length} differences.`
      );
    },
    onError: (error: Error, variables) => {
      updateTreeState(variables.treeId, {
        diffResult: [],
        lastError: `Diff failed: ${error.message}`,
      });
      toast.error(`Diff failed: ${error.message}`);
    },
  });
}

// --- Garbage Collect Mutation ---
interface GarbageCollectArgs extends BaseTreeMutationArgs {
  gcLiveHashesHex: string; // Comma-separated hex strings
}
export function useGarbageCollectMutation() {
  const { updateTreeState } = useAppStore();
  // We also need exportChunks logic here for the onSuccess
  const exportChunksForGC = async (tree: WasmProllyTree) => {
    const chunkMap = (await tree.exportChunks()) as Map<Uint8Array, Uint8Array>;
    const exportedChunks: { hash: string; size: number }[] = [];
    for (const [keyU8, valueU8] of chunkMap.entries()) {
      exportedChunks.push({ hash: u8ToHex(keyU8), size: valueU8.length });
    }
    return exportedChunks;
  };

  return useMutation({
    mutationFn: async (args: GarbageCollectArgs) => {
      const liveHashesU8Arrays: Uint8Array[] = args.gcLiveHashesHex
        .split(",")
        .map((h) => h.trim())
        .filter((h) => h.length > 0) // Ensure not to process empty strings from split
        .map((h) => {
          const u8Arr = hexToU8(h);
          if (!u8Arr) throw new Error(`Invalid live hash hex string: ${h}`);
          return u8Arr;
        });

      const collectedCount = await args.tree.triggerGc(liveHashesU8Arrays);
      const updatedChunks = await exportChunksForGC(args.tree); // Refresh chunks after GC
      return {
        treeId: args.treeId,
        gcCollectedCount: collectedCount,
        chunks: updatedChunks,
      };
    },
    onSuccess: (data) => {
      updateTreeState(data.treeId, {
        gcCollectedCount: data.gcCollectedCount,
        chunks: data.chunks,
        lastError: null,
      });
      toast.success(
        `${data.gcCollectedCount} chunk(s) collected by GC. Chunk list refreshed.`
      );
    },
    onError: (error: Error, variables) => {
      updateTreeState(variables.treeId, {
        gcCollectedCount: null,
        lastError: `GC failed: ${error.message}`,
      });
      toast.error(`GC failed: ${error.message}`);
    },
  });
}

// --- Refresh Root Hash Mutation ---
export function useRefreshRootHashMutation() {
  const { updateTreeState } = useAppStore();
  return useMutation({
    mutationFn: async (args: BaseTreeMutationArgs) => {
      const newRootHashU8 = await args.tree.getRootHash();
      return { treeId: args.treeId, newRootHash: u8ToHex(newRootHashU8) };
    },
    onSuccess: (data) => {
      updateTreeState(data.treeId, {
        rootHash: data.newRootHash,
        lastError: null,
      });
      toast.success("Root hash refreshed.");
    },
    onError: (error: Error, variables) => {
      updateTreeState(variables.treeId, {
        lastError: `Failed to refresh root hash: ${error.message}`,
      });
      toast.error(`Failed to refresh root hash: ${error.message}`);
    },
  });
}

// --- Save Tree To File Mutation ---
interface SaveTreeArgs extends BaseTreeMutationArgs {
  description?: string; // Optional description for the V2 format
}
export function useSaveTreeToFileMutation() {
  const { trees } = useAppStore(); // Still used to get treeId or other metadata if needed for filename
  return useMutation({
    mutationFn: async (args: SaveTreeArgs) => {
      const currentTreeState = trees.find((t) => t.id === args.treeId);
      if (!currentTreeState) {
        // It's good to check if the tree exists in the app's state,
        // though args.tree is the primary WasmProllyTree instance.
        throw new Error(
          `Tree with ID "${args.treeId}" not found in app state.`
        );
      }

      // Call the Wasm function to get the file bytes
      // The saveTreeToFileBytes method is on the WasmProllyTree instance.
      // It takes an optional description string.
      const fileBytesU8 = await args.tree.saveTreeToFileBytes(
        args.description || undefined
      ); // Pass description or undefined

      if (!fileBytesU8 || fileBytesU8.length === 0) {
        throw new Error("Wasm module returned empty file data.");
      }

      // The Wasm function now returns a Uint8Array directly
      return {
        buffer: fileBytesU8.buffer, // Get ArrayBuffer from Uint8Array for Blob
        filename: generateTreeFilename(args.treeId), // Keep your filename generation logic
      };
    },
    onSuccess: (data: { buffer: ArrayBuffer; filename: string }) => {
      triggerBrowserDownload(data.buffer, data.filename);
      toast.success("Tree saved to file successfully.");
    },
    onError: (error: Error) => {
      console.error("Save tree to file failed:", error);
      toast.error(
        `Save tree failed: ${error.message || "Wasm error during save"}`
      );
    },
  });
}

interface JsonlItem {
  key: string;
  value: string;
}
interface ApplyJsonlBatchArgs extends BaseTreeMutationArgs {
  items: JsonlItem[];
}

export function useApplyJsonlBatchMutation() {
  const { updateTreeState } = useAppStore();

  return useMutation({
    mutationFn: async (args: ApplyJsonlBatchArgs) => {
      if (args.items.length === 0) {
        // It's not an error to apply an empty batch, but we can provide feedback.
        return {
          treeId: args.treeId,
          newRootHash: u8ToHex(await args.tree.getRootHash()),
          count: 0,
          noOp: true,
        };
      }

      const batchForWasm: [Uint8Array, Uint8Array][] = args.items.map(
        (item) => [toU8(item.key), toU8(item.value)]
      );

      await args.tree.insertBatch(batchForWasm); // This is the Wasm function
      const newRootHashU8 = await args.tree.getRootHash();
      return {
        treeId: args.treeId,
        newRootHash: u8ToHex(newRootHashU8),
        count: args.items.length,
        noOp: false,
      };
    },
    onSuccess: (data) => {
      updateTreeState(data.treeId, {
        rootHash: data.newRootHash,
        lastError: null,
      });
      if (data.noOp) {
        toast.info("No items provided in JSONL batch.");
      } else {
        toast.success(
          `Successfully applied ${data.count} entries from JSONL batch.`
        );
      }
      // Potentially invalidate queries that depend on tree items, e.g., the scan view
      // queryClient.invalidateQueries({ queryKey: ['items', data.treeId, /* currentScanArgs */] });
    },
    onError: (error: Error, variables) => {
      updateTreeState(variables.treeId, {
        lastError: `JSONL batch apply failed: ${error.message}`,
      });
      toast.error(`JSONL batch apply failed: ${error.message}`);
    },
  });
}

// --- Download Scan as JSONL Mutation ---
interface DownloadScanAsJsonlArgs extends BaseTreeMutationArgs {
  // Use the client-defined ScanArgsWasm, omitting pagination for the full scan logic.
  scanArgs: Omit<ScanArgsWasm, "offset" | "limit">;
}

export function useDownloadScanAsJsonlMutation() {
  return useMutation({
    mutationFn: async (args: DownloadScanAsJsonlArgs) => {
      const { tree, treeId, scanArgs } = args;
      const allItems: { key: string; value: string }[] = [];
      let currentOffset = 0;
      const DOWNLOAD_BATCH_SIZE = 200;

      // eslint-disable-next-line no-constant-condition
      while (true) {
        // Construct the argument object for Wasm based on ScanArgsWasm
        const currentScanArgsForWasm: ScanArgsWasm = {
          ...scanArgs,
          offset: currentOffset,
          limit: DOWNLOAD_BATCH_SIZE,
        };

        // Call Wasm, which takes `any` and returns `Promise<any>`
        // We cast the result to our expected ScanPageWasm structure.
        const page = (await tree.scanItems(
          currentScanArgsForWasm
        )) as ScanPageWasm;

        if (page.items && page.items.length > 0) {
          page.items.forEach((pair: [Uint8Array, Uint8Array]) => {
            allItems.push({
              key: u8ToString(pair[0]),
              value: u8ToString(pair[1]),
            });
          });
        }

        if (
          !page.hasNextPage ||
          (page.items && page.items.length < DOWNLOAD_BATCH_SIZE)
        ) {
          break;
        }
        currentOffset += page.items?.length || 0;
      }

      if (allItems.length === 0) {
        toast.info("No items found matching current scan filters to download.");
        return null;
      }

      const jsonlString = allItems
        .map((item) => JSON.stringify({ key: item.key, value: item.value }))
        .join("\n");

      const filename = `prolly_scan_${treeId}_${new Date()
        .toISOString()
        .replace(/[:.]/g, "-")}.jsonl`;
      return { data: new TextEncoder().encode(jsonlString), filename };
    },
    onSuccess: (result, variables) => {
      if (result) {
        triggerBrowserDownload(
          result.data,
          result.filename,
          "application/jsonl"
        );
        toast.success(
          `Downloaded scan results for tree "${variables.treeId}" as JSONL.`
        );
      }
    },
    onError: (error: Error, variables) => {
      toast.error(
        `Failed to download scan for tree "${variables.treeId}": ${error.message}`
      );
    },
  });
}

const generateTreeFilename = (treeId: string): string => {
  const cleanTreeId = treeId.replace(/[^a-z0-9]/gi, "_").toLowerCase();
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  return `prolly-tree-${cleanTreeId}-${timestamp}.prly`;
};

const triggerBrowserDownload = (
  data: ArrayBuffer | Blob,
  filename: string,
  mimeType: string = "application/octet-stream"
): void => {
  const blob =
    data instanceof Blob ? data : new Blob([data], { type: mimeType });
  const link = document.createElement("a");
  link.href = URL.createObjectURL(blob);
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(link.href);
};

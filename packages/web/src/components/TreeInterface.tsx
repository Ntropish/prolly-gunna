// src/components/TreeInterface.tsx
import React, { useState, useCallback, useEffect } from "react";
import { WasmProllyTree } from "prolly-wasm"; // Keep WasmProllyTree for type check if needed
import { TreeState, useAppStore, JsTreeConfigType } from "@/useAppStore";
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "./ui/card";
import { Button } from "./ui/button";
import { Alert, AlertDescription, AlertTitle } from "./ui/alert";
import {
  Loader2,
  CheckCircle,
  XCircle,
  FileDown,
  RefreshCw,
} from "lucide-react";
import {
  FILE_SIGNATURE,
  FILE_VERSION,
  TAG_METADATA,
  TAG_CHUNK,
  toU8,
  u8ToHex,
  generateTreeFilename,
  triggerBrowserDownload,
} from "@/lib/prollyUtils";

import { OperationSection } from "./treeOperations/OperationSection";
import { BasicOpsComponent } from "./treeOperations/BasicOps";
import { DataExplorerComponent } from "./treeOperations/DataExplorer";
import { AdvancedOpsComponent } from "./treeOperations/AdvancedOps";
import {
  type OperationProps,
  type TreeOperation,
} from "./treeOperations/common";

import { toast } from "sonner";
import { VirtualizedTreeItems } from "./treeOperations/VirtualizedTreeItems";

interface TreeInterfaceProps {
  treeState: TreeState;
}

export function TreeInterface({ treeState }: TreeInterfaceProps) {
  const { updateTreeState } = useAppStore();

  const [loadingStates, setLoadingStates] = useState<
    Record<TreeOperation, boolean>
  >({
    insert: false,
    get: false,
    delete: false,
    list: false,
    exportChunks: false,
    diff: false,
    gc: false,
    save: false,
    refreshHash: false,
  });

  const setLoading = (op: TreeOperation, isLoading: boolean) => {
    setLoadingStates((prev) => ({ ...prev, [op]: isLoading }));
  };

  /**
   * Centralized way to update the specific tree's state in Zustand and set local UI feedback.
   */
  const updateTreeStoreAndLocalFeedback = useCallback(
    (
      updates: Partial<Omit<TreeState, "id" | "tree">>,
      feedbackMsg?: { type: "success" | "error"; message: string }
    ) => {
      updateTreeState(treeState.id, {
        // Clear old direct error/value when new feedback comes or specific updates are made
        ...(feedbackMsg ? { lastError: null, lastValue: null } : {}),
        ...updates,
      });

      if (feedbackMsg) {
        toast[feedbackMsg.type](feedbackMsg.message, {
          description: feedbackMsg.message,
          duration: 6000,
        });
      } else if (updates.lastError && !feedbackMsg) {
        toast.error(updates.lastError, {
          description: updates.lastError,
          duration: 6000,
        });
      } else if (updates.lastValue && !feedbackMsg) {
        toast.success(updates.lastValue, {
          description: updates.lastValue,
          duration: 6000,
        });
      }
      // If no explicit feedbackMsg, and no lastError/lastValue in updates, feedback could persist or be cleared by timer.
    },
    [treeState.id, updateTreeState]
  );

  const refreshRootHashDisplay = useCallback(
    async (showSuccessFeedback = false) => {
      setLoading("refreshHash", true);
      try {
        const rh = await treeState.tree.getRootHash();
        const newRootHash = u8ToHex(rh);
        const feedbackMsg = showSuccessFeedback
          ? ({
              type: "success",
              message: "Root hash successfully refreshed.",
            } as { type: "success" | "error"; message: string })
          : undefined;
        updateTreeStoreAndLocalFeedback({ rootHash: newRootHash }, feedbackMsg);
      } catch (e: any) {
        updateTreeStoreAndLocalFeedback(
          {},
          { type: "error", message: e.message }
        );
      } finally {
        setLoading("refreshHash", false);
      }
    },
    [treeState.tree, updateTreeStoreAndLocalFeedback]
  );

  const handleSaveTreeToFile = async () => {
    setLoading("save", true);
    try {
      const rootHashU8 = await treeState.tree.getRootHash();
      const treeConfigFromWasm = await treeState.tree.getTreeConfig(); // Expect JS object if Wasm uses to_value
      const treeConfig = treeConfigFromWasm as JsTreeConfigType; // Cast

      if (!treeConfig || typeof treeConfig.targetFanout !== "number") {
        throw new Error(
          "Failed to obtain valid tree configuration from Wasm for saving."
        );
      }

      const chunksMap = await treeState.tree.exportChunks();
      const chunkCount = chunksMap.size;

      const metadata = {
        rootHash: rootHashU8 ? u8ToHex(rootHashU8) : null,
        treeConfig: treeConfig, // Use the JS object
        createdAt: new Date().toISOString(),
        chunkCount: chunkCount,
      };
      const metadataJsonString = JSON.stringify(metadata);
      const metadataBytes = toU8(metadataJsonString);

      let totalSize = FILE_SIGNATURE.length + 1 + 1 + 4 + metadataBytes.length;
      const chunksArray: { hash: Uint8Array; data: Uint8Array }[] = [];
      chunksMap.forEach((data, hash) => {
        chunksArray.push({ hash, data });
        totalSize += 1 + 4 + 32 + data.length;
      });

      const buffer = new ArrayBuffer(totalSize);
      const view = new DataView(buffer);
      let offset = 0;

      toU8(FILE_SIGNATURE).forEach((byte, i) =>
        view.setUint8(offset + i, byte)
      );
      offset += FILE_SIGNATURE.length;
      view.setUint8(offset, FILE_VERSION);
      offset += 1;
      view.setUint8(offset, TAG_METADATA);
      offset += 1;
      view.setUint32(offset, metadataBytes.length, true);
      offset += 4;
      new Uint8Array(buffer, offset, metadataBytes.length).set(metadataBytes);
      offset += metadataBytes.length;

      for (const chunk of chunksArray) {
        view.setUint8(offset, TAG_CHUNK);
        offset += 1;
        view.setUint32(offset, 32 + chunk.data.length, true);
        offset += 4;
        new Uint8Array(buffer, offset, 32).set(chunk.hash);
        offset += 32;
        new Uint8Array(buffer, offset, chunk.data.length).set(chunk.data);
        offset += chunk.data.length;
      }

      triggerBrowserDownload(buffer, generateTreeFilename(treeState.id));
      toast.success("Tree save to file initiated.", {
        description: "Tree save to file initiated.",
        duration: 6000,
      });
    } catch (e: any) {
      console.error("Save tree error:", e);
      toast.error(`Save failed: ${e.message}`, {
        description: `Save failed: ${e.message}`,
        duration: 6000,
      });
    } finally {
      setLoading("save", false);
    }
  };

  // Callback for AdvancedOps to trigger chunk export after GC
  const triggerChunkExportAfterGc = useCallback(async () => {
    setLoading("exportChunks", true); // Use the existing exportChunks loading state
    try {
      const chunkMap = await treeState.tree.exportChunks();
      const exportedChunks: { hash: string; size: number }[] = [];
      chunkMap.forEach((value: Uint8Array, key: Uint8Array) => {
        exportedChunks.push({ hash: u8ToHex(key), size: value.length });
      });
      updateTreeStoreAndLocalFeedback({ chunks: exportedChunks }); // Update chunks without new feedback bubble
    } catch (e: any) {
      updateTreeStoreAndLocalFeedback(
        { chunks: [] },
        { type: "error", message: `Failed to refresh chunks: ${e.message}` }
      );
    } finally {
      setLoading("exportChunks", false);
    }
  }, [treeState.tree, updateTreeStoreAndLocalFeedback]);

  const commonOpProps: OperationProps = {
    tree: treeState.tree,
    treeId: treeState.id,
    setLoading,
    loadingStates,
    refreshRootHash: refreshRootHashDisplay,
    updateTreeStoreState: updateTreeStoreAndLocalFeedback, // Pass the new centralized update function
  };

  return (
    <Card className="w-full shadow-lg border">
      <CardHeader className="pb-4">
        <CardTitle className="text-xl tracking-tight">
          Tree Instance:{" "}
          <span className="font-mono text-base bg-muted px-2 py-1 rounded">
            {treeState.id}
          </span>
        </CardTitle>
        <CardDescription className="pt-1">
          Current Root Hash:{" "}
          <span className="font-mono text-xs">
            {treeState.rootHash || "N/A (Empty Tree)"}
          </span>
          {treeState.treeConfig && (
            <span className="block text-xs text-muted-foreground mt-1">
              (Config: Target Fanout {treeState.treeConfig.targetFanout}, Min
              Fanout {treeState.treeConfig.minFanout}, Max Inline Value{" "}
              {treeState.treeConfig.maxInlineValueSize}B, CDC Min{" "}
              {treeState.treeConfig.cdcMinSize}B / Avg{" "}
              {treeState.treeConfig.cdcAvgSize}B / Max{" "}
              {treeState.treeConfig.cdcMaxSize}B)
            </span>
          )}
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-1 pt-2">
        <OperationSection title="Basic Operations" defaultOpen={true}>
          <BasicOpsComponent {...commonOpProps} />
        </OperationSection>

        <OperationSection title="Scan" defaultOpen={true}>
          {treeState.tree ? ( // Ensure tree is loaded
            <VirtualizedTreeItems
              currentRoot={treeState.rootHash}
              tree={treeState.tree as WasmProllyTree} // Cast if WasmProllyTree from store is different
              height="400px"
              itemHeight={65} // Slightly taller for better readability
            />
          ) : (
            <p>Tree instance not available.</p>
          )}
        </OperationSection>

        <OperationSection title="Data & Chunks Exploration">
          <DataExplorerComponent
            {...commonOpProps}
            items={treeState.items}
            chunks={treeState.chunks}
          />
        </OperationSection>

        <OperationSection title="Advanced Operations">
          <AdvancedOpsComponent
            {...commonOpProps}
            diffResult={treeState.diffResult}
            gcCollectedCount={treeState.gcCollectedCount}
            triggerChunkExport={triggerChunkExportAfterGc}
          />
        </OperationSection>
      </CardContent>
      <CardFooter className="flex-col items-stretch gap-2 pt-6 border-t sm:flex-row sm:justify-between">
        <Button
          onClick={() => refreshRootHashDisplay(true)}
          variant="outline"
          disabled={loadingStates.refreshHash}
          className="w-full sm:w-auto"
        >
          {loadingStates.refreshHash ? (
            <Loader2 className="mr-2 h-4 w-4 animate-spin" />
          ) : (
            <RefreshCw className="mr-2 h-4 w-4" />
          )}
          Refresh Root Hash
        </Button>
        <Button
          onClick={handleSaveTreeToFile}
          disabled={loadingStates.save}
          className="w-full sm:w-auto"
        >
          {loadingStates.save ? (
            <Loader2 className="mr-2 h-4 w-4 animate-spin" />
          ) : (
            <FileDown className="mr-2 h-4 w-4" />
          )}
          Save Tree to File
        </Button>
      </CardFooter>
    </Card>
  );
}

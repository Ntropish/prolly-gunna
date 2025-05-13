// src/components/TreeInterface.tsx
import React from "react"; // Removed useState, useCallback, useEffect if no longer needed for local states
import { type WasmProllyTree } from "prolly-wasm";
import { type TreeState, useAppStore } from "@/useAppStore"; // JsTreeConfigType might not be needed here directly
import {
  Card,
  CardContent,
  CardDescription,
  // CardFooter, // Will use new mutation for save
  CardHeader,
  CardTitle,
} from "./ui/card";

import { Button } from "./ui/button"; // Removed: Button variant="outline" for refresh
import { Loader2, FileDown, RefreshCw } from "lucide-react";
// Removed: FILE_SIGNATURE, FILE_VERSION, TAG_METADATA, TAG_CHUNK, toU8, u8ToHex, generateTreeFilename, triggerBrowserDownload (moved to hook)

import { OperationSection } from "./treeOperations/OperationSection";
import { BasicOpsComponent } from "./treeOperations/BasicOps";
import { DataExplorerComponent } from "./treeOperations/DataExplorer"; // Will be refactored next
import { AdvancedOpsComponent } from "./treeOperations/AdvancedOps"; // Will be refactored next
// Removed: type OperationProps, type TreeOperation

// import { toast } from "sonner"; // Toasts handled by mutations
import { VirtualizedTreeItems } from "./treeOperations/VirtualizedTreeItems";
import {
  useRefreshRootHashMutation,
  useSaveTreeToFileMutation,
} from "@/hooks/useTreeMutations";
import { CardFooter } from "@/components/ui/card";

interface TreeInterfaceProps {
  treeState: TreeState;
}

export function TreeInterface({ treeState }: TreeInterfaceProps) {
  // Removed: updateTreeState (mutations will call useAppStore().updateTreeState directly)
  // Removed: loadingStates, setLoading (handled by mutations)
  // Removed: refreshRootHashDisplay (handled by useRefreshRootHashMutation)
  // Removed: handleSaveTreeToFile (handled by useSaveTreeToFileMutation)
  // Removed: triggerChunkExportAfterGc (will be handled by GC mutation's onSuccess)

  const refreshRootHashMutation = useRefreshRootHashMutation();
  const saveTreeMutation = useSaveTreeToFileMutation();

  const handleRefresh = () => {
    refreshRootHashMutation.mutate({
      treeId: treeState.id,
      tree: treeState.tree,
    });
  };

  const handleSave = () => {
    saveTreeMutation.mutate({ treeId: treeState.id, tree: treeState.tree });
  };

  // Props for child components will be simplified
  const commonProps = {
    tree: treeState.tree,
    treeId: treeState.id,
  };

  // Props for DataExplorer & AdvancedOps that rely on store data
  const dataDisplayProps = {
    items: treeState.items,
    chunks: treeState.chunks,
    diffResult: treeState.diffResult,
    gcCollectedCount: treeState.gcCollectedCount,
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
        {/* Pass only necessary props. BasicOpsComponent now uses hooks for its actions. */}
        <OperationSection title="Basic Operations" defaultOpen={true}>
          <BasicOpsComponent tree={treeState.tree} treeId={treeState.id} />
        </OperationSection>

        <OperationSection title="Scan" defaultOpen={true}>
          {treeState.tree ? (
            <VirtualizedTreeItems
              currentRoot={treeState.rootHash}
              tree={treeState.tree as WasmProllyTree}
              height="400px"
              itemHeight={65}
            />
          ) : (
            <p>Tree instance not available.</p>
          )}
        </OperationSection>

        {/* DataExplorerComponent and AdvancedOpsComponent will also be refactored to use mutations */}
        <OperationSection title="Log Chunks">
          <DataExplorerComponent
            {...commonProps}
            {...dataDisplayProps}
            // setLoading, loadingStates, updateTreeStoreState removed
          />
        </OperationSection>

        <OperationSection title="Advanced Operations">
          <AdvancedOpsComponent
            {...commonProps}
            {...dataDisplayProps}
            // setLoading, loadingStates, updateTreeStoreState, triggerChunkExport removed/refactored
            // triggerChunkExport will be part of GCMutation's onSuccess or a separate mutation
            triggerChunkExport={async () => {
              // This will be replaced by a mutation for exporting chunks,
              // called within the GC mutation's onSuccess.
              // For now, this prop might need to be removed or refactored.
              console.warn(
                "triggerChunkExport in AdvancedOpsComponent needs refactoring with mutations."
              );
            }}
          />
        </OperationSection>
      </CardContent>
      <CardFooter className="flex-col items-stretch gap-2 pt-6 border-t sm:flex-row sm:justify-between">
        <Button
          onClick={handleRefresh}
          variant="outline"
          disabled={refreshRootHashMutation.isPending}
          className="w-full sm:w-auto"
        >
          {refreshRootHashMutation.isPending ? (
            <Loader2 className="mr-2 h-4 w-4 animate-spin" />
          ) : (
            <RefreshCw className="mr-2 h-4 w-4" />
          )}
          Refresh Root Hash
        </Button>
        <Button
          onClick={handleSave}
          disabled={saveTreeMutation.isPending}
          className="w-full sm:w-auto"
        >
          {saveTreeMutation.isPending ? (
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

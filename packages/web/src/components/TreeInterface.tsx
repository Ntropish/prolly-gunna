// src/components/TreeInterface.tsx
import React from "react"; // Removed useState, useRef, ChangeEvent from here
import { type WasmProllyTree } from "prolly-wasm";
import { type TreeState } from "@/useAppStore"; // Removed useAppStore if not directly used
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "./ui/card";
import { Button } from "./ui/button";
// Input, Label, Textarea removed if not directly used here
import { Loader2, FileDown, RefreshCw } from "lucide-react"; // Removed Layers, UploadCloud, FileUp

import { OperationSection } from "./treeOperations/OperationSection";
import { BasicOpsComponent } from "./treeOperations/BasicOps";
import { DataExplorerComponent } from "./treeOperations/DataExplorer";
import { AdvancedOpsComponent } from "./treeOperations/AdvancedOps";
import { VirtualizedTreeItems } from "./treeOperations/VirtualizedTreeItems";
import { JsonlBatchArea } from "./treeOperations/JsonlBatchArea"; // Import new component
import { JsonlFileLoaderComponent } from "./treeOperations/JsonlFileLoader"; // Import new component
import {
  useRefreshRootHashMutation,
  useSaveTreeToFileMutation,
  // useApplyJsonlBatchMutation // Not directly used here anymore
} from "@/hooks/useTreeMutations";
// import { toast } from "sonner"; // Not directly used here

interface TreeInterfaceProps {
  treeState: TreeState;
}

export function TreeInterface({ treeState }: TreeInterfaceProps) {
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

  const commonProps = {
    tree: treeState.tree,
    treeId: treeState.id,
  };
  const dataDisplayProps = {
    items: treeState.items,
    chunks: treeState.chunks,
    diffResult: treeState.diffResult,
    gcCollectedCount: treeState.gcCollectedCount,
  };

  return (
    <Card className="w-full shadow-lg border">
      <CardHeader>
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
          <BasicOpsComponent tree={treeState.tree} treeId={treeState.id} />
        </OperationSection>

        <OperationSection title="Scan" defaultOpen={true}>
          {treeState.tree ? (
            <VirtualizedTreeItems
              currentRoot={treeState.rootHash}
              tree={treeState.tree as WasmProllyTree}
              treeId={treeState.id}
              height="400px"
              itemHeight={65}
            />
          ) : (
            <p>Tree instance not available.</p>
          )}
        </OperationSection>

        <OperationSection title="Batch Insert (JSONL)" defaultOpen={false}>
          <div className="space-y-4">
            <JsonlFileLoaderComponent
              tree={treeState.tree}
              treeId={treeState.id}
            />
            <JsonlBatchArea tree={treeState.tree} treeId={treeState.id} />
          </div>
        </OperationSection>

        <OperationSection title="Log Chunks">
          <DataExplorerComponent
            {...commonProps}
            items={dataDisplayProps.items}
            chunks={dataDisplayProps.chunks}
          />
        </OperationSection>

        <OperationSection title="Advanced Operations">
          <AdvancedOpsComponent
            {...commonProps}
            diffResult={dataDisplayProps.diffResult}
            gcCollectedCount={dataDisplayProps.gcCollectedCount}
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

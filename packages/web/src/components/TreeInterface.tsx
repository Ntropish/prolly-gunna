// src/components/TreeInterface.tsx
import React from "react"; // Removed useState, useRef, ChangeEvent from here
import { type WasmProllyTree } from "prolly-wasm";
// import { type TreeState } from "@/useAppStore"; // Removed useAppStore if not directly used
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
import { Loader2, FileDown, RefreshCw, Save } from "lucide-react"; // Removed Layers, UploadCloud, FileUp

import { OperationSection } from "./treeOperations/OperationSection";
import { BasicOpsComponent } from "./treeOperations/BasicOps";
import { DataExplorerComponent } from "./treeOperations/DataExplorer.old";
import { AdvancedOpsComponent } from "./treeOperations/AdvancedOps";
import { VirtualizedTreeItems } from "./treeOperations/VirtualizedTreeItems";
import { VirtualizedHierarchyScan } from "./treeOperations/VirtualizedHierarchyScan";
import { JsonlBatchArea } from "./treeOperations/JsonlBatchArea";
import { JsonlFileLoaderComponent } from "./treeOperations/JsonlFileLoader";
import {
  useRefreshRootHashMutation,
  useSaveTreeToFileMutation,
} from "@/hooks/useTreeMutations";
import { useProllyStore, type ProllyTree } from "@/useProllyStore";

interface TreeInterfaceProps {
  treeState: ProllyTree;
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

  const handleDownload = () => {
    saveTreeMutation.mutate({ treeId: treeState.id, tree: treeState.tree });
  };

  const handleSave = () => {
    useProllyStore.getState().saveTree(treeState.id);
  };

  const commonProps = {
    tree: treeState.tree,
    treeId: treeState.id,
  };

  console.log("treeState", treeState);

  return (
    <Card className="w-full shadow-lg border">
      <CardHeader>
        <CardTitle className="text-xl tracking-tight">
          Tree Instance:{" "}
          <span className="font-mono text-base bg-muted px-2 py-1 rounded">
            {treeState.id}
          </span>
          <span className="ml-2">
            <Button size="icon" onClick={handleSave}>
              <Save className="h-4 w-4" />
            </Button>
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

        <OperationSection title="Tree Scan" defaultOpen={true}>
          {treeState.tree ? (
            <VirtualizedHierarchyScan
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

        <OperationSection title="Advanced Operations">
          <AdvancedOpsComponent {...commonProps} />
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
          onClick={handleDownload}
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

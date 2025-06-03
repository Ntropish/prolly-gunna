// src/components/TreeInterface.tsx
import React from "react";
import { type WasmProllyTree } from "prolly-wasm";
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "./ui/card";
import { Button } from "./ui/button";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "./ui/tabs"; // Added Tabs imports
import { Loader2, FileDown, RefreshCw, Save, Trash } from "lucide-react";

// Removed OperationSection import as it's being replaced by Tabs
import { BasicOpsComponent } from "./treeOperations/BasicOps";
// DataExplorerComponent was marked as .old, assuming it's not primary for this refactor
// import { DataExplorerComponent } from "./treeOperations/DataExplorer.old";
import { AdvancedOpsComponent, DiffComponent } from "./treeOperations/Diff";
import { ScanEntries } from "./treeOperations/ScanEntries";
import { VirtualizedHierarchyScan } from "./treeOperations/VirtualizedHierarchyScan";
import { JsonlBatchArea } from "./treeOperations/JsonlBatchArea";
import { JsonlFileLoaderComponent } from "./treeOperations/JsonlFileLoader";

import { useProllyStore, type ProllyTree } from "@/useProllyStore";
import { GarbageCollectionComponent } from "./treeOperations/GarbageCollection";
import { triggerBrowserDownload } from "@/lib/prollyUtils";
import { toast } from "sonner";
import { useMutation } from "@tanstack/react-query";
import { ProllyFilePanel } from "./treeOperations/FilePanel";
// import { RenameDialog } from "./treeOperations/RenameDialog";
import {
  adjectives,
  animals,
  uniqueNamesGenerator,
} from "unique-names-generator";
interface TreeInterfaceProps {
  treeState: ProllyTree;
}

export function TreeInterface({ treeState }: TreeInterfaceProps) {
  const trees = useProllyStore((state) => state.trees);
  const saveTreeMutation = useMutation({
    mutationFn: async (args: { description?: string }) => {
      const currentTreeState = trees[treeState.path];
      if (!currentTreeState) {
        throw new Error(
          `Tree with ID "${args.treeId}" not found in app state.`
        );
      }

      const fileBytesU8 = await currentTreeState.tree.saveTreeToFileBytes(
        args.description || undefined
      );

      if (!fileBytesU8 || fileBytesU8.length === 0) {
        throw new Error("Wasm module returned empty file data.");
      }

      return {
        buffer: fileBytesU8.buffer,
        filename:
          treeState.path ||
          `${uniqueNamesGenerator({
            dictionaries: [adjectives, animals],
            separator: "-",
            length: 2,
          })}.prly`,
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

  const handleSave = () => {
    useProllyStore.getState().saveTree(treeState.path);
  };

  const commonProps = {
    tree: treeState.tree,
    treeId: treeState.id,
  };

  // Define default active tab, e.g., "basic"
  const defaultTab = "scan";

  return (
    <Card className="w-full shadow-lg border">
      <CardHeader>
        <CardTitle className="text-xl tracking-tight flex items-center gap-2">
          <span className="font-mono text-base bg-muted px-2 py-1 rounded">
            {treeState.path}
          </span>
          {/* <RenameDialog treeId={treeState.id} currentName={treeState.id} /> */}
          <span className="ml-2 flex gap-2 ml-auto">
            {treeState.rootHash !== treeState.lastSavedRootHash && (
              <Button size="icon" onClick={handleSave}>
                <Save className="h-4 w-4" />
              </Button>
            )}
          </span>
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-1 pt-2">
        <Tabs defaultValue={defaultTab} className="w-full">
          <TabsList className="grid w-full grid-cols-3 mb-4 grid-rows-3 h-24 ">
            <TabsTrigger value="scan">Scan</TabsTrigger>
            <TabsTrigger value="basic">Basic Ops</TabsTrigger>
            <TabsTrigger value="hierarchyScan">Tree Scan</TabsTrigger>
            <TabsTrigger value="batchInsert">JSONL</TabsTrigger>
            <TabsTrigger value="file">File</TabsTrigger>
            <TabsTrigger value="diff">Diff</TabsTrigger>
            <TabsTrigger value="gc">GC</TabsTrigger>
          </TabsList>

          <TabsContent value="basic" className="border-t pt-4">
            <BasicOpsComponent tree={treeState.tree} treeId={treeState.id} />
          </TabsContent>

          <TabsContent value="scan" className="border-t pt-4">
            {treeState.tree ? (
              <ScanEntries
                currentRoot={treeState.rootHash}
                tree={treeState.tree as WasmProllyTree}
                treePath={treeState.path}
                height="400px"
                itemHeight={65}
              />
            ) : (
              <p>Tree instance not available.</p>
            )}
          </TabsContent>

          <TabsContent value="hierarchyScan" className="border-t pt-4">
            {treeState.tree ? (
              <VirtualizedHierarchyScan
                currentRoot={treeState.rootHash}
                tree={treeState.tree as WasmProllyTree}
                treePath={treeState.path}
                height="400px"
                itemHeight={65} // Adjust as needed, hierarchy items might be taller
              />
            ) : (
              <p>Tree instance not available.</p>
            )}
          </TabsContent>

          <TabsContent value="file" className="border-t pt-4">
            <ProllyFilePanel
              tree={treeState.tree}
              treePath={treeState.path}
              treeConfig={treeState.treeConfig}
              rootHash={treeState.rootHash}
            />
          </TabsContent>

          <TabsContent value="batchInsert" className="border-t pt-4">
            <div className="space-y-4">
              <JsonlFileLoaderComponent
                tree={treeState.tree}
                treePath={treeState.path}
              />
              <JsonlBatchArea tree={treeState.tree} treePath={treeState.path} />
            </div>
          </TabsContent>

          <TabsContent value="diff" className="border-t pt-4">
            <DiffComponent {...commonProps} />
          </TabsContent>

          <TabsContent value="gc" className="border-t pt-4">
            <GarbageCollectionComponent
              tree={treeState.tree}
              treeId={treeState.id}
            />
          </TabsContent>
        </Tabs>
      </CardContent>
    </Card>
  );
}

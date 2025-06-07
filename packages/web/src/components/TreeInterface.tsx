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

import { ProllyFilePanel } from "./treeOperations/FilePanel";
import TreeManagement from "./tree-management";
import { AddEntryDialog } from "./treeOperations/AddEntryDialog";
import { TestComponent } from "./test-component";
// import { RenameDialog } from "./treeOperations/RenameDialog";

interface TreeInterfaceProps {
  treeState: ProllyTree;
}

export function TreeInterface({ treeState }: TreeInterfaceProps) {
  const handleSave = () => {
    useProllyStore.getState().saveTree(treeState.path);
  };

  // Define default active tab, e.g., "basic"
  const defaultTab = "scan";

  return (
    <Card className="w-full shadow-lg border flex-1 overflow-hidden h-full p-1">
      <CardHeader>
        <CardTitle className="text-xl tracking-tight flex items-center gap-2">
          <span className="px-2 py-1 rounded font-mono">
            {treeState.path.replace(/\.prly$/, "")}
          </span>
          {/* <RenameDialog treeId={treeState.id} currentName={treeState.id} /> */}
          <span className="ml-2 flex gap-2 ml-auto">
            <AddEntryDialog tree={treeState} />
            {/* {treeState.rootHash !== treeState.lastSavedRootHash && (
              <Button size="icon" onClick={handleSave}>
                <Save className="h-4 w-4" />
              </Button>
            )} */}
          </span>
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-1 pt-2 h-full min-h-0 flex flex-col p-1">
        <Tabs
          defaultValue={defaultTab}
          className="w-full min-h-0 flex flex-col"
        >
          <TabsList className="grid w-full grid-cols-3 mb-2 grid-rows-1 h-8 ">
            <TabsTrigger value="scan">Scan</TabsTrigger>
            <TabsTrigger value="management">Management</TabsTrigger>
            <TabsTrigger value="test">Test</TabsTrigger>
          </TabsList>

          <TabsContent
            value="scan"
            className="pt-2 min-h-0 flex-1 overflow-hidden min-h-0"
          >
            {treeState.tree ? (
              <ScanEntries
                key={`tree-${treeState.path}-${treeState.rootHash}`}
                currentRoot={treeState.rootHash}
                prly={treeState}
                treePath={treeState.path}
                height="400px"
                itemHeight={65}
              />
            ) : (
              <p>Tree instance not available.</p>
            )}
          </TabsContent>

          <TabsContent value="management" className="pt-4">
            <TreeManagement treeState={treeState} />
          </TabsContent>

          <TabsContent value="test" className="pt-4">
            <TestComponent />
          </TabsContent>
        </Tabs>
      </CardContent>
    </Card>
  );
}

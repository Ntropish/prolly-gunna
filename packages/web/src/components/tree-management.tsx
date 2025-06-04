// src/components/TreeInterface.tsx
import { type WasmProllyTree } from "prolly-wasm";

import { Tabs, TabsContent, TabsList, TabsTrigger } from "./ui/tabs"; // Added Tabs imports

// Removed OperationSection import as it's being replaced by Tabs
// DataExplorerComponent was marked as .old, assuming it's not primary for this refactor
// import { DataExplorerComponent } from "./treeOperations/DataExplorer.old";
import { DiffComponent } from "./treeOperations/Diff";
import { VirtualizedHierarchyScan } from "./treeOperations/VirtualizedHierarchyScan";

import { type ProllyTree } from "@/useProllyStore";
import { GarbageCollectionComponent } from "./treeOperations/GarbageCollection";

import { ProllyFilePanel } from "./treeOperations/FilePanel";

export default function TreeManagement({
  treeState,
  defaultTab = "config",
}: {
  treeState: ProllyTree;
  defaultTab?: string;
}) {
  return (
    <Tabs defaultValue={defaultTab} className="w-full min-h-0 flex flex-col">
      <TabsList className="grid w-full grid-cols-4 mb-2 grid-rows-1 h-8 ">
        <TabsTrigger value="config">Config</TabsTrigger>
        <TabsTrigger value="hierarchyScan">Nodes</TabsTrigger>
        <TabsTrigger value="diff">Diff</TabsTrigger>
        <TabsTrigger value="gc">GC</TabsTrigger>
      </TabsList>

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

      <TabsContent value="config" className="border-t pt-4">
        <ProllyFilePanel
          tree={treeState.tree}
          treePath={treeState.path}
          treeConfig={treeState.treeConfig}
          rootHash={treeState.rootHash}
        />
      </TabsContent>

      <TabsContent value="diff" className="border-t pt-4">
        <DiffComponent tree={treeState.tree} treePath={treeState.path} />
      </TabsContent>

      <TabsContent value="gc" className="border-t pt-4">
        <GarbageCollectionComponent
          tree={treeState.tree}
          treePath={treeState.path}
        />
      </TabsContent>
    </Tabs>
  );
}

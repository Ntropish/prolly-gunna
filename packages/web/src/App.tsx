import "./App.css";
import React, { useState, useEffect } from "react"; // Removed unused useMemo, useCallback
import { WasmProllyTree } from "prolly-wasm";
import { useAppStore, type TreeState } from "./useAppStore"; // Ensure TreeState is exported
// Removed produce as it's not directly used in App.tsx anymore
import { Button } from "./components/ui/button";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "./components/ui/tabs";
import { TreeInterface } from "./components/TreeInterface";

const u8ToHex = (u8: Uint8Array | null | undefined): string => {
  if (!u8) return "null";
  return Array.from(u8)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
};

function App() {
  const trees = useAppStore((state) => state.trees);
  const addTree = useAppStore((state) => state.addTree);
  const updateTreeState = useAppStore((state) => state.updateTreeState);

  const [activeTab, setActiveTab] = useState<string | undefined>(undefined);

  // Effect to set active tab when trees change (e.g., first tree created)
  useEffect(() => {
    if (!activeTab && trees.length > 0) {
      setActiveTab(trees[0].id);
    }
  }, [trees, activeTab]);

  const handleCreateTree = async () => {
    const newTree = new WasmProllyTree(); // This is synchronous
    const treeId = `tree-${Date.now()}`;
    try {
      const rootHash = await newTree.getRootHash(); // getRootHash is async
      const newTreeState: TreeState = {
        id: treeId,
        tree: newTree,
        rootHash: u8ToHex(rootHash),
        lastError: null,
        lastValue: null,
        items: [],
        chunks: [],
        diffResult: [],
        gcCollectedCount: null,
      };
      addTree(newTreeState);
      if (!activeTab || trees.length === 0) {
        // Set active tab if it's the first tree
        setActiveTab(treeId);
      }
    } catch (e: any) {
      console.error("Failed to initialize tree and get root hash:", e);
      // Optionally, handle this error in the UI, e.g., by setting a global error state
      // For now, we'll just log it and not add the tree if getRootHash fails.
    }
  };

  return (
    <div className="App p-4 space-y-4">
      <header className="flex justify-between items-center">
        <h1 className="text-2xl font-bold">Prolly Web UI</h1>
        <Button onClick={handleCreateTree}>Create New Tree</Button>
      </header>

      {trees.length === 0 ? (
        <p>No trees created yet. Click "Create New Tree" to start.</p>
      ) : (
        <Tabs value={activeTab} onValueChange={setActiveTab} className="w-full">
          <TabsList className="grid w-full grid-cols-dynamic min-[400px]:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6">
            {trees.map((t) => (
              <TabsTrigger key={t.id} value={t.id}>
                {t.id.substring(0, 10)}...
              </TabsTrigger>
            ))}
          </TabsList>
          {trees.map((treeState) => (
            <TabsContent key={treeState.id} value={treeState.id}>
              <TreeInterface treeState={treeState} />
            </TabsContent>
          ))}
        </Tabs>
      )}
    </div>
  );
}

export default App;

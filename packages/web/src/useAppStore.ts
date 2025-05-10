import type { WasmProllyTree } from "prolly-wasm";
import { create } from "zustand";
import init from "prolly-wasm"; // Ensure this is the correct import for your Wasm module

// Initialize the Wasm module
init().then(() => {
  console.log("Wasm module initialized");
});

// Define the state for a single tree
export interface TreeState {
  id: string; // Unique identifier for the tree
  tree: WasmProllyTree; // The WasmProllyTree instance
  rootHash: string | null;
  lastError: string | null;
  lastValue: string | null;
  items: { key: string; value: string }[];
  chunks: { hash: string; size: number }[];
  diffResult: { key: string; left?: string; right?: string }[];
  gcCollectedCount: number | null;
}

// Define the overall application state
interface AppStore {
  trees: TreeState[];
  addTree: (treeState: TreeState) => void;
  updateTreeState: (
    treeId: string,
    updates: Partial<Omit<TreeState, "id" | "tree">>
  ) => void;
  // `removeTree` could be added later if needed
}

export const useAppStore = create<AppStore>()(
  // Not using persist middleware for now as WasmProllyTree instances are not easily serializable directly.
  // If persistence is needed, tree state (rootHash + chunks) would need to be serialized and reloaded.
  (set) => ({
    trees: [],
    addTree: (newTreeState) =>
      set((state) => ({
        trees: [...state.trees, newTreeState],
      })),
    updateTreeState: (treeId, updates) =>
      set((state) => ({
        trees: state.trees.map((t) =>
          t.id === treeId ? { ...t, ...updates } : t
        ),
      })),
  })
);

import type { WasmProllyTree } from "prolly-wasm";
import { create } from "zustand";

// This type is used for JS objects representing TreeConfig
export interface JsTreeConfigType {
  targetFanout: number;
  minFanout: number;
  cdcMinSize: number;
  cdcAvgSize: number;
  cdcMaxSize: number;
  maxInlineValueSize: number;
}

export interface TreeState {
  id: string;
  tree: WasmProllyTree;
  rootHash: string | null;
  treeConfig: JsTreeConfigType | null; // Configuration of this tree instance
  lastError: string | null;
  lastValue: string | null; // General feedback message area
  items: { key: string; value: string }[];
  chunks: { hash: string; size: number }[];
  diffResult: { key: string; left?: string; right?: string }[];
  gcCollectedCount: number | null;
}

interface AppStore {
  trees: TreeState[];
  addTree: (treeState: TreeState) => void;
  updateTreeState: (
    treeId: string,
    updates: Partial<Omit<TreeState, "id" | "tree">>
  ) => void;
}

export const useAppStore = create<AppStore>()((set) => ({
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
}));

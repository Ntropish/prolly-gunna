// src/components/treeOperations/common.ts
import { WasmProllyTree } from "prolly-wasm";
import { type TreeState } from "@/useAppStore"; // Assuming JsTreeConfigType is exported

export type TreeOperation =
  | "insert"
  | "get"
  | "delete"
  | "list"
  | "exportChunks"
  | "diff"
  | "gc"
  | "save"
  | "refreshHash";

export interface OperationProps {
  tree: WasmProllyTree; // The actual Wasm tree instance
  treeId: string;
  // For sub-components that don't need the full treeState, but specific parts.
  // Or, pass the full treeState and let sub-components pick what they need.
  // For simplicity now, passing specific handlers.
  setLoading: (op: TreeOperation, isLoading: boolean) => void;
  loadingStates: Record<TreeOperation, boolean>;

  refreshRootHash: (showFeedback?: boolean) => Promise<void>;
  updateTreeStoreState: (
    updates: Partial<Omit<TreeState, "id" | "tree">>
  ) => void; // For updating items, chunks etc.
}
// Specific data display props, if needed by sub-components
export interface DataDisplayProps {
  items: TreeState["items"];
  chunks: TreeState["chunks"];
  diffResult: TreeState["diffResult"];
  gcCollectedCount: TreeState["gcCollectedCount"];
}

// src/components/treeOperations/common.ts
import { WasmProllyTree } from "prolly-wasm";
import { type TreeState } from "@/useAppStore"; // Assuming JsTreeConfigType is exported

export interface OperationProps {
  tree: WasmProllyTree; // The actual Wasm tree instance
  treeId: string;
}
// Specific data display props, if needed by sub-components
export interface DataDisplayProps {
  items: TreeState["items"];
  chunks: TreeState["chunks"];
  diffResult: TreeState["diffResult"];
  gcCollectedCount: TreeState["gcCollectedCount"];
}

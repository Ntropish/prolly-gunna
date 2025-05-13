// src/components/treeOperations/DataExplorer.tsx
import React from "react";
import { type WasmProllyTree } from "prolly-wasm";
import { type TreeState } from "@/useAppStore";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Loader2, List, PackageOpen } from "lucide-react";
// u8ToString, u8ToHex will be used within the mutation hooks now
// import { WasmProllyTreeCursor } from "prolly-wasm"; // Used in mutation
// import { toast } from "sonner"; // Handled by mutation
import {
  useListItemsMutation,
  useExportChunksMutation,
} from "@/hooks/useTreeMutations";

interface DataExplorerProps {
  tree: WasmProllyTree;
  treeId: string;
  items: TreeState["items"]; // Comes from TreeInterface -> treeState
  chunks: TreeState["chunks"]; // Comes from TreeInterface -> treeState
}

export const DataExplorerComponent: React.FC<DataExplorerProps> = ({
  tree,
  treeId,
  items,
  chunks,
}) => {
  const listItemsMutation = useListItemsMutation();
  const exportChunksMutation = useExportChunksMutation();

  const handleListItems = () => {
    listItemsMutation.mutate({ tree, treeId });
  };

  const handleExportChunks = () => {
    exportChunksMutation.mutate({ tree, treeId });
  };

  return (
    <>
      <div className="space-y-2">
        <div className="flex justify-between items-center">
          <h4 className="font-medium text-sm">
            All Items in Tree ({items.length})
          </h4>
          <Button
            onClick={handleListItems}
            disabled={listItemsMutation.isPending}
            size="sm"
            variant="outline"
          >
            {listItemsMutation.isPending ? (
              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
            ) : (
              <List className="mr-2 h-4 w-4" />
            )}{" "}
            Show Items
          </Button>
        </div>
        {items.length > 0 && (
          <ScrollArea className="h-40 max-h-60 w-full rounded-md border p-2 mt-1 bg-muted/30">
            <pre className="text-xs text-left whitespace-pre-wrap break-all">
              {items
                .map(
                  (item, idx) =>
                    `Key: ${item.key}\nValue: ${item.value}${
                      idx < items.length - 1 ? "\n──────────────────" : ""
                    }`
                )
                .join("\n")}
            </pre>
          </ScrollArea>
        )}
      </div>
      <div className="space-y-2">
        <div className="flex justify-between items-center">
          <h4 className="font-medium text-sm">
            Stored Chunks ({chunks.length})
          </h4>
          <Button
            onClick={handleExportChunks}
            disabled={exportChunksMutation.isPending}
            size="sm"
            variant="outline"
          >
            {exportChunksMutation.isPending ? (
              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
            ) : (
              <PackageOpen className="mr-2 h-4 w-4" />
            )}{" "}
            Show Chunks
          </Button>
        </div>
        {chunks.length > 0 && (
          <ScrollArea className="h-40 max-h-60 w-full rounded-md border p-2 mt-1 bg-muted/30">
            <pre className="text-xs text-left">
              {chunks
                .map((chunk) => `Hash: ${chunk.hash} (Size: ${chunk.size} B)`)
                .join("\n")}
            </pre>
          </ScrollArea>
        )}
      </div>
    </>
  );
};

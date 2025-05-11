// src/components/treeOperations/DataExplorerComponent.tsx
import React from "react";
import { type OperationProps } from "./common";
import { type TreeState } from "@/useAppStore";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Loader2, List, PackageOpen } from "lucide-react";
import { WasmProllyTreeCursor } from "prolly-wasm";
import { u8ToString, u8ToHex } from "@/lib/prollyUtils";
import { toast } from "sonner";

interface DataExplorerProps extends OperationProps {
  items: TreeState["items"];
  chunks: TreeState["chunks"];
}

export const DataExplorerComponent: React.FC<DataExplorerProps> = ({
  tree,
  setLoading,
  loadingStates,
  updateTreeStoreState,
  items,
  chunks,
}) => {
  const handleListItems = async () => {
    setLoading("list", true);
    try {
      const fetchedItems: { key: string; value: string }[] = [];
      const cursor: WasmProllyTreeCursor = await tree.cursorStart();
      while (true) {
        const result = await cursor.next();
        if (result.done) break;
        if (result.value) {
          const [keyU8, valueU8] = result.value;
          fetchedItems.push({
            key: u8ToString(keyU8),
            value: u8ToString(valueU8),
          });
        }
      }
      updateTreeStoreState({ items: fetchedItems });

      toast.success(`Listed ${fetchedItems.length} items.`);
    } catch (e: any) {
      updateTreeStoreState({ items: [] });
      toast.error(e.message);
    } finally {
      setLoading("list", false);
    }
  };

  const handleExportChunks = async () => {
    setLoading("exportChunks", true);
    try {
      const chunkMap = await tree.exportChunks();
      const exportedChunks: { hash: string; size: number }[] = [];
      chunkMap.forEach((value: Uint8Array, key: Uint8Array) => {
        exportedChunks.push({ hash: u8ToHex(key), size: value.length });
      });
      updateTreeStoreState({ chunks: exportedChunks });

      toast.success(`Exported ${exportedChunks.length} chunks.`);
    } catch (e: any) {
      updateTreeStoreState({ chunks: [] });
      toast.error(e.message);
    } finally {
      setLoading("exportChunks", false);
    }
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
            disabled={loadingStates.list}
            size="sm"
            variant="outline"
          >
            {loadingStates.list ? (
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
            disabled={loadingStates.exportChunks}
            size="sm"
            variant="outline"
          >
            {loadingStates.exportChunks ? (
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

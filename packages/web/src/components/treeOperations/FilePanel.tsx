// packages/web/src/components/treeOperations/JsonlFileLoader.tsx
import { type TreeConfigOptions, type WasmProllyTree } from "prolly-wasm";
import { Button } from "@/components/ui/button";
import { Loader2, Trash, FileDown } from "lucide-react";
import { toast } from "sonner";
import { useProllyStore } from "@/useProllyStore";
import { triggerBrowserDownload } from "@/lib/prollyUtils";
import { useMutation } from "@tanstack/react-query";
import { TreeInfoPanel } from "./TreeInfoPanel";

interface JsonlFileLoaderProps {
  tree: WasmProllyTree;
  treePath: string;
  treeConfig: TreeConfigOptions | null;
  rootHash: string | null;
}

export const ProllyFilePanel: React.FC<JsonlFileLoaderProps> = ({
  tree,
  treePath,
  treeConfig,
  rootHash,
}) => {
  const downloadMutation = useMutation({
    mutationFn: async ({ description }: { description?: string }) => {
      if (!tree) {
        throw new Error(`No tree provided for saving.`);
      }

      const fileBytesU8 = await tree.saveTreeToFileBytes(
        description || undefined
      );

      if (!fileBytesU8 || fileBytesU8.length === 0) {
        throw new Error("Wasm module returned empty file data.");
      }

      return {
        buffer: fileBytesU8.buffer,
        filename: treePath,
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

  const handleDownload = () => {
    downloadMutation.mutate({ description: "BasicOps Download" });
  };

  const handleDelete = () => {
    useProllyStore.getState().deleteTree(treePath);
  };

  return (
    <div className="space-y-2 flex flex-col gap-2">
      <TreeInfoPanel
        treeState={{
          rootHash: rootHash,
          treeConfig: treeConfig,
        }}
      />
      <div className="flex flex-row gap-2 justify-between">
        <div>
          <Button
            onClick={handleDelete}
            variant="destructive"
            className="sm:w-auto"
          >
            <Trash className="mr-2 h-4 w-4" />
            Delete
          </Button>
        </div>

        <div className="flex flex-row gap-2">
          <Button
            className="flex-1"
            onClick={handleDownload}
            disabled={downloadMutation.isPending}
          >
            {downloadMutation.isPending ? (
              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
            ) : (
              <FileDown className="mr-2 h-4 w-4" />
            )}
            Download PRLY
          </Button>
        </div>
      </div>
    </div>
  );
};

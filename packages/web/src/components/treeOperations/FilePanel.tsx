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
  return (
    <div className="space-y-2 flex flex-col gap-2">
      <TreeInfoPanel
        treeState={{
          rootHash: rootHash,
          treeConfig: treeConfig,
        }}
      />
    </div>
  );
};

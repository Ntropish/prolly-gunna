import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useProllyStore } from "@/useProllyStore";
import type { WasmProllyTree } from "prolly-wasm";
import { toU8, u8ToHex } from "@/lib/prollyUtils";
import { toast } from "sonner";

interface JsonlItem {
  key: string;
  value: string;
}

export const useApplyJsonlMutation = ({
  tree,
  treePath,
}: {
  tree: WasmProllyTree;
  treePath: string;
}) => {
  const applyJsonlMutation = useMutation({
    mutationFn: async (args: { items: JsonlItem[] }) => {
      if (args.items.length === 0) {
        return {
          count: 0,
          noOp: true,
        };
      }

      const batchForWasm: [Uint8Array, Uint8Array][] = args.items.map(
        (item) => [toU8(item.key), toU8(item.value)]
      );

      await tree.insertBatch(batchForWasm); // This is the Wasm function
      const newRootHashU8 = await tree.getRootHash();
      return {
        treePath: treePath,
        newRootHash: u8ToHex(newRootHashU8),
        count: args.items.length,
        noOp: false,
      };
    },
    onSuccess: (data) => {
      useProllyStore.getState().treeUpdated(treePath);
      if (data.noOp) {
        toast.info("No items provided in JSONL batch.");
      } else {
        toast.success(
          `Successfully applied ${data.count} entries from JSONL batch.`
        );
      }
    },
    onError: (error: Error) => {
      useProllyStore
        .getState()
        .treeError(treePath, `JSONL batch apply failed: ${error.message}`);
      toast.error(`JSONL batch apply failed: ${error.message}`);
    },
  });

  return applyJsonlMutation;
};

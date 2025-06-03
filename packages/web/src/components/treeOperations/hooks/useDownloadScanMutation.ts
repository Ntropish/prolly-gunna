import { triggerBrowserDownload, u8ToString } from "@/lib/prollyUtils";
import type { ScanArgsWasm } from "@/lib/types";
import type { ScanPageWasm } from "@/lib/types";
import { useMutation } from "@tanstack/react-query";
import type { WasmProllyTree } from "prolly-wasm";
import { toast } from "sonner";

export const useDownloadScanMutation = ({
  tree,
  treePath,
}: {
  tree: WasmProllyTree | null;
  treePath: string;
}) => {
  return useMutation({
    mutationFn: async (scanArgs: Omit<ScanArgsWasm, "offset" | "limit">) => {
      const allItems: { key: string; value: string }[] = [];
      let currentOffset = 0;
      const DOWNLOAD_BATCH_SIZE = 200;

      while (true) {
        // Construct the argument object for Wasm based on ScanArgsWasm
        const currentScanArgsForWasm: ScanArgsWasm = {
          ...scanArgs,
          offset: currentOffset,
          limit: DOWNLOAD_BATCH_SIZE,
        };

        // Call Wasm, which takes `any` and returns `Promise<any>`
        // We cast the result to our expected ScanPageWasm structure.
        if (!tree) throw new Error("Tree not available for download.");
        const page = (await tree.scanItems(
          currentScanArgsForWasm
        )) as ScanPageWasm;

        if (page.items && page.items.length > 0) {
          page.items.forEach((pair: [Uint8Array, Uint8Array]) => {
            allItems.push({
              key: u8ToString(pair[0]),
              value: u8ToString(pair[1]),
            });
          });
        }

        if (
          !page.hasNextPage ||
          (page.items && page.items.length < DOWNLOAD_BATCH_SIZE)
        ) {
          break;
        }
        currentOffset += page.items?.length || 0;
      }

      if (allItems.length === 0) {
        toast.info("No items found matching current scan filters to download.");
        return null;
      }

      const jsonlString = allItems
        .map((item) => JSON.stringify({ key: item.key, value: item.value }))
        .join("\n");

      const filename = `${treePath.replace(/\.prly$/, "")}_${new Date()
        .toISOString()
        .replace(/[:.]/g, "-")}.jsonl`;
      return { data: new TextEncoder().encode(jsonlString), filename };
    },
    onSuccess: (result) => {
      if (result) {
        triggerBrowserDownload(
          result.data,
          result.filename,
          "application/jsonl"
        );
        toast.success(
          `Downloaded scan results for tree "${treePath}" as JSONL.`
        );
      }
    },
    onError: (error: Error) => {
      toast.error(
        `Failed to download scan for tree "${treePath}": ${error.message}`
      );
    },
  });
};

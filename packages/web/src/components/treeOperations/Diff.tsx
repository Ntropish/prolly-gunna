// src/components/treeOperations/AdvancedOps.tsx
import React, { useState } from "react";
import { type DiffEntry, type WasmProllyTree } from "prolly-wasm";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Loader2, GitCompareArrows } from "lucide-react";
import { useMutation } from "@tanstack/react-query";
import { hexToU8, u8ToString } from "@/lib/prollyUtils";
import { toast } from "sonner";
import { useProllyStore } from "@/useProllyStore";
import { ScrollArea } from "@radix-ui/react-scroll-area";

interface DiffProps {
  tree: WasmProllyTree;
  treePath: string;
}
interface StringDiffEntry {
  key: string;
  left: string | undefined;
  right: string | undefined;
}
export const DiffComponent: React.FC<DiffProps> = ({ tree, treePath }) => {
  const [diffHash1, setDiffHash1] = useState("");
  const [diffHash2, setDiffHash2] = useState("");

  const diffMutation = useMutation({
    mutationFn: async ({ left, right }: { left: string; right: string }) => {
      const h1U8 = left.trim() ? hexToU8(left.trim()) : null;
      const h2U8 = right.trim() ? hexToU8(right.trim()) : null;

      if (left.trim() && !h1U8)
        throw new Error(`Invalid hex string for Left Root Hash: ${left}`);
      if (right.trim() && !h2U8)
        throw new Error(`Invalid hex string for Right Root Hash: ${right}`);

      const diffEntriesJs = await tree.diffRoots(h1U8, h2U8);

      const formattedDiffs: StringDiffEntry[] = diffEntriesJs.map(
        (entry: DiffEntry) => ({
          key: u8ToString(entry.key),
          left: entry.leftValue ? u8ToString(entry.leftValue) : undefined,
          right: entry.rightValue ? u8ToString(entry.rightValue) : undefined,
        })
      );
      return { treePath: treePath, diffResult: formattedDiffs };
    },
    onSuccess: (data) => {
      useProllyStore.getState().treeUpdated(treePath);
      toast.success(
        `Diff computed with ${data.diffResult.length} differences.`
      );
      console.log(data);
    },
    onError: (error: Error) => {
      useProllyStore
        .getState()
        .treeError(treePath, `Diff failed: ${error.message}`);
      toast.error(`Diff failed: ${error.message}`);
    },
  });

  const handleDiff = () => {
    diffMutation.mutate({
      left: diffHash1,
      right: diffHash2,
    });
  };

  const diffResult = diffMutation.data?.diffResult;

  return (
    <>
      <div className="space-y-2">
        <h4 className="font-medium text-sm">
          Diff Hashes in this tree's store
        </h4>
        <div className="flex flex-col gap-2">
          <Input
            placeholder="Left"
            value={diffHash1}
            onChange={(e) => setDiffHash1(e.target.value)}
            disabled={diffMutation.isPending}
          />
          <Input
            placeholder="Right"
            value={diffHash2}
            onChange={(e) => setDiffHash2(e.target.value)}
            disabled={diffMutation.isPending}
          />
          <Button
            onClick={handleDiff}
            disabled={diffMutation.isPending}
            className="w-full sm:w-auto"
          >
            {diffMutation.isPending ? (
              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
            ) : (
              <GitCompareArrows className="mr-2 h-4 w-4" />
            )}{" "}
            Diff
          </Button>
        </div>
        {diffResult && diffResult.length > 0 && (
          <ScrollArea className="h-40 max-h-60 w-full rounded-md border p-2 mt-1 bg-muted/30">
            <pre className="text-xs text-left whitespace-pre-wrap break-all">
              {diffResult
                .map(
                  (d, idx) =>
                    `Key: ${d.key}\n  Left: ${d.left ?? "N/A"}\n  Right: ${
                      d.right ?? "N/A"
                    }${
                      idx < diffResult.length - 1 ? "\n──────────────────" : ""
                    }`
                )
                .join("\n")}
            </pre>
          </ScrollArea>
        )}
      </div>
    </>
  );
};

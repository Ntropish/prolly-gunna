// src/components/treeOperations/AdvancedOps.tsx
import React, { useState } from "react";
import { type WasmProllyTree } from "prolly-wasm";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Loader2, GitCompareArrows, Eraser } from "lucide-react";
// u8ToString, hexToU8 are now used within mutations
// import { toast } from "sonner"; // Handled by mutations
import {
  useDiffTreesMutation,
  useGarbageCollectMutation,
} from "@/hooks/useTreeMutations";

interface AdvancedOpsProps {
  tree: WasmProllyTree;
  treeId: string;
  // diffResult: TreeState["diffResult"]; // Display data from Zustand store
  // gcCollectedCount: TreeState["gcCollectedCount"]; // Display data
  // triggerChunkExport prop is removed
}

export const AdvancedOpsComponent: React.FC<AdvancedOpsProps> = ({
  tree,
  treeId,
  // diffResult,
  // gcCollectedCount,
}) => {
  const [diffHash1, setDiffHash1] = useState("");
  const [diffHash2, setDiffHash2] = useState("");
  const [gcLiveHashes, setGcLiveHashes] = useState("");

  const diffTreesMutation = useDiffTreesMutation();
  const garbageCollectMutation = useGarbageCollectMutation();

  const handleDiff = () => {
    diffTreesMutation.mutate({
      treeId,
      tree,
      hash1Hex: diffHash1,
      hash2Hex: diffHash2,
    });
  };

  const handleGc = () => {
    garbageCollectMutation.mutate({
      treeId,
      tree,
      gcLiveHashesHex: gcLiveHashes,
    });
  };

  return (
    <>
      <div className="space-y-2">
        <h4 className="font-medium text-sm">
          Diff Trees (using this tree's store)
        </h4>
        <div className="flex flex-col gap-2">
          <Input
            placeholder="Root Hash 1 (hex, blank for current tree's left side of diff if Hash2 is also blank, else empty tree)"
            value={diffHash1}
            onChange={(e) => setDiffHash1(e.target.value)}
            disabled={diffTreesMutation.isPending}
          />
          <Input
            placeholder="Root Hash 2 (hex, blank for current tree's right side of diff, else empty tree)"
            value={diffHash2}
            onChange={(e) => setDiffHash2(e.target.value)}
            disabled={diffTreesMutation.isPending}
          />
          <Button
            onClick={handleDiff}
            disabled={diffTreesMutation.isPending}
            className="w-full sm:w-auto"
          >
            {diffTreesMutation.isPending ? (
              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
            ) : (
              <GitCompareArrows className="mr-2 h-4 w-4" />
            )}{" "}
            Diff
          </Button>
        </div>
        {/* {diffResult.length > 0 && (
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
        )} */}
      </div>
      <div className="space-y-2">
        <h4 className="font-medium text-sm">Garbage Collection</h4>
        <Textarea
          placeholder="Live Root Hashes (comma-separated hex strings). Current tree's root is always included."
          value={gcLiveHashes}
          onChange={(e) => setGcLiveHashes(e.target.value)}
          rows={2}
          disabled={garbageCollectMutation.isPending}
        />
        <Button
          onClick={handleGc}
          disabled={garbageCollectMutation.isPending}
          className="w-full sm:w-auto"
        >
          {garbageCollectMutation.isPending ? (
            <Loader2 className="mr-2 h-4 w-4 animate-spin" />
          ) : (
            <Eraser className="mr-2 h-4 w-4" />
          )}{" "}
          Trigger GC
        </Button>
        {/* {gcCollectedCount !== null && (
          <p className="text-sm mt-1 text-muted-foreground">
            Chunks collected in last GC run: {gcCollectedCount}
          </p>
        )} */}
      </div>
    </>
  );
};

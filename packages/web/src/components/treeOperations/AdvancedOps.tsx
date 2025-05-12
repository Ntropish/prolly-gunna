import React, { useState } from "react";
import { type OperationProps } from "./common";
import { type TreeState } from "@/useAppStore";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Loader2, GitCompareArrows, Eraser } from "lucide-react";
import { u8ToString, hexToU8 } from "@/lib/prollyUtils";
import { toast } from "sonner";

interface AdvancedOpsProps extends OperationProps {
  diffResult: TreeState["diffResult"];
  gcCollectedCount: TreeState["gcCollectedCount"];
  triggerChunkExport: () => Promise<void>; // Callback to refresh chunks in parent
}

export const AdvancedOpsComponent: React.FC<AdvancedOpsProps> = ({
  tree,
  setLoading,
  loadingStates,
  updateTreeStoreState,
  diffResult,
  gcCollectedCount,
  triggerChunkExport,
}) => {
  const [diffHash1, setDiffHash1] = useState("");
  const [diffHash2, setDiffHash2] = useState("");
  const [gcLiveHashes, setGcLiveHashes] = useState("");

  const handleDiff = async () => {
    setLoading("diff", true);
    try {
      const h1 = hexToU8(diffHash1);
      const h2 = hexToU8(diffHash2);
      const diffEntries = await tree.diffRoots(h1, h2);
      const formattedDiffs = diffEntries.map((entry: any) => ({
        key: u8ToString(entry.key),
        left: entry.leftValue ? u8ToString(entry.leftValue) : undefined,
        right: entry.rightValue ? u8ToString(entry.rightValue) : undefined,
      }));
      updateTreeStoreState({ diffResult: formattedDiffs });

      toast.success(`Diff computed with ${formattedDiffs.length} differences.`);
    } catch (e: any) {
      updateTreeStoreState({ diffResult: [] });
      toast.error(e);
    } finally {
      setLoading("diff", false);
    }
  };

  const handleGc = async () => {
    setLoading("gc", true);
    try {
      const liveHashesU8Arrays = gcLiveHashes
        .split(",")
        .map((h) => h.trim())
        .map((h) => hexToU8(h))
        .filter((arr) => arr !== null) as Uint8Array[];
      const collected = await tree.triggerGc(liveHashesU8Arrays);
      updateTreeStoreState({ gcCollectedCount: collected });
      toast.success(
        `${collected} chunk(s) collected by GC. This tree's store is now smaller.`
      );
      await triggerChunkExport(); // Refresh chunk list in parent
    } catch (e: any) {
      updateTreeStoreState({ gcCollectedCount: null });
      toast.error(e.message);
    } finally {
      setLoading("gc", false);
    }
  };

  return (
    <>
      <div className="space-y-2">
        <h4 className="font-medium text-sm">
          Diff Trees (using this tree's store)
        </h4>
        <div className="flex flex-col gap-2">
          <Input
            placeholder="Root Hash 1 (hex, optional)"
            value={diffHash1}
            onChange={(e) => setDiffHash1(e.target.value)}
            disabled={loadingStates.diff}
          />
          <Input
            placeholder="Root Hash 2 (hex, optional)"
            value={diffHash2}
            onChange={(e) => setDiffHash2(e.target.value)}
            disabled={loadingStates.diff}
          />
          <Button
            onClick={handleDiff}
            disabled={loadingStates.diff}
            className="w-full sm:w-auto"
          >
            {loadingStates.diff ? (
              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
            ) : (
              <GitCompareArrows className="mr-2 h-4 w-4" />
            )}{" "}
            Diff
          </Button>
        </div>
        {diffResult.length > 0 && (
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
      <div className="space-y-2">
        <h4 className="font-medium text-sm">Garbage Collection</h4>
        <Textarea
          placeholder="Live Root Hashes (comma-separated hex strings)"
          value={gcLiveHashes}
          onChange={(e) => setGcLiveHashes(e.target.value)}
          rows={2}
          disabled={loadingStates.gc}
        />
        <Button
          onClick={handleGc}
          disabled={loadingStates.gc}
          className="w-full sm:w-auto"
        >
          {loadingStates.gc ? (
            <Loader2 className="mr-2 h-4 w-4 animate-spin" />
          ) : (
            <Eraser className="mr-2 h-4 w-4" />
          )}{" "}
          Trigger GC
        </Button>
        {gcCollectedCount !== null && (
          <p className="text-sm mt-1 text-muted-foreground">
            Chunks collected in last GC run: {gcCollectedCount}
          </p>
        )}
      </div>
    </>
  );
};

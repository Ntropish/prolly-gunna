// src/components/treeOperations/AdvancedOps.tsx
import React, { useState } from "react";
import { type WasmProllyTree } from "prolly-wasm";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Loader2, Eraser } from "lucide-react";
import { hexToU8 } from "@/lib/prollyUtils";
import { u8ToHex } from "@/lib/prollyUtils";
import { useMutation } from "@tanstack/react-query";
import { toast } from "sonner";
import { useProllyStore } from "@/useProllyStore";

interface GarbageCollectionProps {
  tree: WasmProllyTree;
  treePath: string;
}

// We also need exportChunks logic here for the onSuccess
const exportChunksForGC = async (tree: WasmProllyTree) => {
  const chunkMap = (await tree.exportChunks()) as Map<Uint8Array, Uint8Array>;
  const exportedChunks: { hash: string; size: number }[] = [];
  for (const [keyU8, valueU8] of chunkMap.entries()) {
    exportedChunks.push({ hash: u8ToHex(keyU8), size: valueU8.length });
  }
  return exportedChunks;
};

export const GarbageCollectionComponent: React.FC<GarbageCollectionProps> = ({
  tree,
  treePath,
}) => {
  const [gcLiveHashes, setGcLiveHashes] = useState("");

  const cgMutation = useMutation({
    mutationFn: async ({ gcLiveHashesHex }: { gcLiveHashesHex: string }) => {
      const liveHashesU8Arrays: Uint8Array[] = gcLiveHashesHex
        .split(",")
        .map((h) => h.trim())
        .filter((h) => h.length > 0) // Ensure not to process empty strings from split
        .map((h) => {
          const u8Arr = hexToU8(h);
          if (!u8Arr) throw new Error(`Invalid live hash hex string: ${h}`);
          return u8Arr;
        });

      const collectedCount = await tree.triggerGc(liveHashesU8Arrays);
      const updatedChunks = await exportChunksForGC(tree); // Refresh chunks after GC
      return {
        gcCollectedCount: collectedCount,
        chunks: updatedChunks,
      };
    },
    onSuccess: (data) => {
      useProllyStore.getState().treeUpdated(treePath);
      toast.success(
        `${data.gcCollectedCount} chunk(s) collected by GC. Chunk list refreshed.`
      );
    },
    onError: (error: Error) => {
      useProllyStore
        .getState()
        .treeError(treePath, `GC failed: ${error.message}`);
      toast.error(`GC failed: ${error.message}`);
    },
  });

  const handleGc = () => {
    cgMutation.mutate({
      gcLiveHashesHex: gcLiveHashes,
    });
  };

  return (
    <div className="space-y-2">
      <h4 className="font-medium text-sm">Garbage Collection</h4>
      <Textarea
        placeholder="Live Root Hashes (comma-separated hex strings). Current tree's root is always included."
        value={gcLiveHashes}
        onChange={(e) => setGcLiveHashes(e.target.value)}
        rows={2}
        disabled={cgMutation.isPending}
      />
      <Button
        onClick={handleGc}
        disabled={cgMutation.isPending}
        className="w-full sm:w-auto"
      >
        {cgMutation.isPending ? (
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
  );
};

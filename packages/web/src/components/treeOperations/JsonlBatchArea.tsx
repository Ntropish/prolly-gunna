// packages/web/src/components/treeOperations/JsonlBatchArea.tsx
import React, { useState } from "react";
import { type WasmProllyTree } from "prolly-wasm";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Loader2, Layers } from "lucide-react";
import { toast } from "sonner";
import { toU8 } from "@/lib/prollyUtils";
import { u8ToHex } from "@/lib/prollyUtils";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useProllyStore } from "@/useProllyStore";
import { useApplyJsonlMutation } from "./hooks/useApplyJsonlMutation";

interface JsonlBatchAreaProps {
  tree: WasmProllyTree;
  treePath: string;
}

export const JsonlBatchArea: React.FC<JsonlBatchAreaProps> = ({
  tree,
  treePath,
}) => {
  const [jsonlText, setJsonlText] = useState("");
  const applyJsonlMutation = useApplyJsonlMutation({
    tree,
    treePath,
  });

  const handleApplyJsonl = () => {
    if (!jsonlText.trim()) {
      toast.info("Text area is empty. Nothing to apply.");
      return;
    }
    const lines = jsonlText.split("\n");
    const parsedItems: { key: string; value: string }[] = [];
    let skippedLines = 0;

    for (const line of lines) {
      if (line.trim() === "") continue;
      try {
        const item = JSON.parse(line.trim());
        if (
          item &&
          typeof item.key === "string" &&
          typeof item.value === "string"
        ) {
          parsedItems.push({ key: item.key, value: item.value });
        } else {
          skippedLines++;
          console.warn(
            "Skipping malformed JSONL line from textarea (not key/value strings):",
            line
          );
        }
      } catch (parseError) {
        skippedLines++;
        console.warn(
          `Error parsing JSONL line from textarea: "${line}"`,
          parseError
        );
      }
    }

    if (skippedLines > 0) {
      toast.error(
        `${skippedLines} JSONL line(s) in textarea were malformed or skipped.`
      );
    }

    if (parsedItems.length > 0) {
      applyJsonlMutation.mutate({ items: parsedItems });
    } else if (skippedLines === 0) {
      toast.info("No valid entries found in text area to apply.");
    }
  };

  return (
    <div className="space-y-2">
      <Textarea
        placeholder='{"key": "myKey1", "value": "myValue1"}\n{"key": "myKey2", "value": "myValue2"}'
        value={jsonlText}
        onChange={(e) => setJsonlText(e.target.value)}
        rows={5}
        disabled={applyJsonlMutation.isPending}
        className="font-mono text-xs"
      />
      <Button
        onClick={handleApplyJsonl}
        disabled={applyJsonlMutation.isPending || !jsonlText.trim()}
        className="w-full sm:w-auto"
      >
        {applyJsonlMutation.isPending ? (
          <Loader2 className="mr-2 h-4 w-4 animate-spin" />
        ) : (
          <Layers className="mr-2 h-4 w-4" />
        )}{" "}
        Apply JSONL from Text
      </Button>
    </div>
  );
};

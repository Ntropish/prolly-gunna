// src/components/treeOperations/JsonlTextOps.tsx
import React, { useState } from "react";
import { type OperationProps } from "./common";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { Loader2, CheckCircleSquare } from "lucide-react";
import { toU8 } from "@/lib/prollyUtils";
import { toast } from "sonner";

export const JsonlTextOpsComponent: React.FC<OperationProps> = ({
  tree,
  setLoading,
  loadingStates,
  refreshRootHash,
  // updateTreeStoreState, // Use refreshRootHash and toast directly
}) => {
  const [jsonlInputText, setJsonlInputText] = useState("");

  const handleApplyJsonlText = async () => {
    if (!jsonlInputText.trim()) {
      toast.error("Text area is empty.");
      return;
    }
    setLoading("applyJsonlText", true);
    try {
      const lines = jsonlInputText.split("\n");
      const parsedItems: { key: Uint8Array; value: Uint8Array }[] = [];
      let lineNo = 0;

      for (const line of lines) {
        lineNo++;
        const trimmedLine = line.trim();
        if (trimmedLine === "") continue;

        try {
          const item = JSON.parse(trimmedLine);
          if (
            item &&
            typeof item.key === "string" &&
            typeof item.value === "string"
          ) {
            parsedItems.push({ key: toU8(item.key), value: toU8(item.value) });
          } else {
            toast.warn(
              `Skipping malformed JSON object at line ${lineNo}. Expected {key: string, value: string}. Found: ${trimmedLine.substring(
                0,
                100
              )}`
            );
          }
        } catch (parseError: any) {
          toast.error(
            `Error parsing JSON at line <span class="math-inline">\{lineNo\}\: "</span>{trimmedLine.substring(0,100)}...". ${parseError.message}`
          );
          // Continue processing other lines
        }
      }

      if (parsedItems.length > 0) {
        const jsArrayItems = parsedItems.map((p) => [p.key, p.value]);
        await tree.insertBatch(jsArrayItems as any); // Use the new Wasm batch insert
        await refreshRootHash(true); // Pass true to show success feedback from refresh
        toast.success(
          `Successfully applied ${parsedItems.length} entries from text area.`
        );
        setJsonlInputText(""); // Clear textarea
      } else {
        toast.info("No valid entries found in text area to apply.");
      }
    } catch (e: any) {
      toast.error(`Failed to apply JSONL from text: ${e.message}`);
    } finally {
      setLoading("applyJsonlText", false);
    }
  };

  return (
    <div className="space-y-3">
      <div>
        <Label
          htmlFor={`jsonl-text-input-${tree.id_for_testing_only || "tree"}`}
          className="font-medium text-sm"
        >
          Apply JSONL from Text
        </Label>
        <Textarea
          id={`jsonl-text-input-${tree.id_for_testing_only || "tree"}`}
          placeholder={
            '{\\"key\\": \\"myKey\\", \\"value\\": \\"myValue\\"}\n{\\"key\\": \\"anotherKey\\", \\"value\\": \\"anotherValue\\"}'
          }
          value={jsonlInputText}
          onChange={(e) => setJsonlInputText(e.target.value)}
          rows={5}
          className="mt-1"
          disabled={loadingStates.applyJsonlText}
        />
      </div>
      <Button
        onClick={handleApplyJsonlText}
        disabled={loadingStates.applyJsonlText || !jsonlInputText.trim()}
        className="w-full sm:w-auto"
      >
        {loadingStates.applyJsonlText ? (
          <Loader2 className="mr-2 h-4 w-4 animate-spin" />
        ) : (
          <CheckCircleSquare className="mr-2 h-4 w-4" />
        )}
        Apply Entries
      </Button>
    </div>
  );
};

// packages/web/src/components/treeOperations/JsonlFileLoader.tsx
import React, { useState, useRef, type ChangeEvent } from "react";
import { type WasmProllyTree } from "prolly-wasm";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Loader2, FileUp } from "lucide-react";
import { toast } from "sonner";
import { useApplyJsonlMutation } from "./hooks/useApplyJsonlMutation";

interface JsonlFileLoaderProps {
  tree: WasmProllyTree;
  treePath: string;
}

export const JsonlFileLoaderComponent: React.FC<JsonlFileLoaderProps> = ({
  tree,
  treePath,
}) => {
  const [isLoadingJsonlFile, setIsLoadingJsonlFile] = useState(false);
  const jsonlFileInputRef = useRef<HTMLInputElement>(null);
  const applyJsonlMutation = useApplyJsonlMutation({
    tree,
    treePath,
  });

  const handleJsonlFileSelected = async (
    event: ChangeEvent<HTMLInputElement>
  ) => {
    const file = event.target.files?.[0];
    if (!file) return;

    setIsLoadingJsonlFile(true);
    try {
      const fileContent = await file.text();
      const lines = fileContent.split("\n");
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
              "Skipping malformed JSONL line (not key/value strings):",
              line
            );
          }
        } catch (parseError) {
          skippedLines++;
          console.warn(`Error parsing JSONL line: "${line}"`, parseError);
        }
      }

      if (skippedLines > 0) {
        toast.error(`${skippedLines} JSONL line(s) were malformed or skipped.`);
      }

      if (parsedItems.length > 0) {
        applyJsonlMutation.mutate({ items: parsedItems });
      } else if (skippedLines === 0) {
        toast.info("JSONL file is empty or contains no valid entries.");
      }
    } catch (e: any) {
      toast.error(`Failed to process JSONL file: ${e.message}`);
    } finally {
      setIsLoadingJsonlFile(false);
      if (jsonlFileInputRef.current) jsonlFileInputRef.current.value = "";
    }
  };

  return (
    <div className="space-y-2">
      <h4 className="font-medium text-sm">Load JSONL from File</h4>
      <Label
        htmlFor={`jsonl-file-upload-${treePath}`}
        className="cursor-pointer"
      >
        <Button
          asChild
          variant="outline"
          disabled={isLoadingJsonlFile || applyJsonlMutation.isPending}
          size="sm"
          className="w-full sm:w-auto"
          title="Load key-value pairs from a JSONL file into this tree"
        >
          <span>
            {isLoadingJsonlFile || applyJsonlMutation.isPending ? (
              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
            ) : (
              <FileUp className="mr-2 h-4 w-4" />
            )}
            Select JSONL File
          </span>
        </Button>
      </Label>
      <Input
        ref={jsonlFileInputRef}
        id={`jsonl-file-upload-${treePath}`}
        type="file"
        className="hidden"
        onChange={handleJsonlFileSelected}
        accept=".jsonl,.jsonlines"
        disabled={isLoadingJsonlFile || applyJsonlMutation.isPending}
      />
    </div>
  );
};

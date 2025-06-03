import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

import { Download, EllipsisVertical, FileText, FileUp } from "lucide-react";
import { Trash } from "lucide-react";
import { toast } from "sonner";
import { useApplyJsonlMutation } from "./treeOperations/hooks/useApplyJsonlMutation";
import type { WasmProllyTree } from "prolly-wasm";
import { Input } from "./ui/input";
import { useState, type FormEvent } from "react";
import { useRef, type ChangeEvent } from "react";
import type { ProllyTree } from "@/useProllyStore";
import { triggerBrowserDownload } from "@/lib/prollyUtils";
import { useMutation } from "@tanstack/react-query";
import { useProllyStore } from "@/useProllyStore";
import { Button } from "./ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "./ui/dialog";
import { JsonlBatchArea } from "./treeOperations/JsonlBatchArea";
import { Textarea } from "./ui/textarea";
import { useDownloadScanMutation } from "./treeOperations/hooks/useDownloadScanMutation";

function parseJsonlFile(fileContent: string) {
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

  return { parsedItems, skippedLines };
}
export function TreeMenu({
  prly,
  treePath,
}: {
  prly: ProllyTree;
  treePath: string;
}) {
  const jsonlFileInputRef = useRef<HTMLInputElement>(null);
  const applyJsonlMutation = useApplyJsonlMutation({
    tree: prly.tree,
    treePath,
  });

  const [isLoadingJsonlFile, setIsLoadingJsonlFile] = useState(false);

  const [isDeleteDialogOpen, setIsDeleteDialogOpen] = useState(false);

  const [isJsonlDialogOpen, setIsJsonlDialogOpen] = useState(false);

  const [jsonlText, setJsonlText] = useState("");

  const handleJsonlFileSelected = async (
    event: ChangeEvent<HTMLInputElement>
  ) => {
    const file = event.target.files?.[0];
    if (!file) return;

    setIsLoadingJsonlFile(true);
    try {
      const fileContent = await file.text();
      const { parsedItems, skippedLines } = parseJsonlFile(fileContent);

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

  const handleJsonlTextSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();

    const { parsedItems, skippedLines } = parseJsonlFile(jsonlText);

    if (skippedLines > 0) {
      toast.error(`${skippedLines} JSONL line(s) were malformed or skipped.`);
    }

    if (parsedItems.length > 0) {
      applyJsonlMutation.mutate({ items: parsedItems });
    } else if (skippedLines === 0) {
      toast.info("JSONL file is empty or contains no valid entries.");
    }

    setJsonlText("");
    setIsJsonlDialogOpen(false);

    toast.success(
      `Successfully applied ${parsedItems.length} JSONL entries to tree.`
    );
  };

  const downloadMutation = useMutation({
    mutationFn: async ({ description }: { description?: string }) => {
      if (!prly.tree) {
        throw new Error(`No tree provided for saving.`);
      }

      const fileBytesU8 = await prly.tree.saveTreeToFileBytes(
        description || undefined
      );

      if (!fileBytesU8 || fileBytesU8.length === 0) {
        throw new Error("Wasm module returned empty file data.");
      }

      return {
        buffer: fileBytesU8.buffer,
        filename: treePath,
      };
    },
    onSuccess: (data: { buffer: ArrayBuffer; filename: string }) => {
      triggerBrowserDownload(data.buffer, data.filename);
      toast.success("Tree saved to file successfully.");
    },
    onError: (error: Error) => {
      console.error("Save tree to file failed:", error);
      toast.error(
        `Save tree failed: ${error.message || "Wasm error during save"}`
      );
    },
  });

  const handleDownload = () => {
    downloadMutation.mutate({ description: "BasicOps Download" });
  };

  const downloadScanMutation = useDownloadScanMutation({
    tree: prly.tree,
    treePath: treePath.replace(/\.prly$/, ".jsonl"),
  });

  const handleDownloadScan = () => {
    if (!prly.tree) {
      toast.error("Tree instance not available for download.");
      return;
    }
    downloadScanMutation.mutate({});
  };

  const handleDelete = () => {
    useProllyStore.getState().deleteTree(treePath);
  };

  return (
    <>
      <DropdownMenu modal={false}>
        <DropdownMenuTrigger asChild>
          <button className="p-2 rounded-md hover:bg-gray-100 focus:outline-none focus:ring-2 focus:ring-blue-500">
            <EllipsisVertical className="h-5 w-5 text-muted-foreground" />
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          <DropdownMenuLabel>Actions</DropdownMenuLabel>
          <DropdownMenuItem onClick={handleDownload}>
            <Download className="mr-2 h-4 w-4" />
            Download PRLY
          </DropdownMenuItem>
          <DropdownMenuItem onClick={handleDownloadScan}>
            <FileText className="mr-2 h-4 w-4" />
            Download JSONL
          </DropdownMenuItem>
          <DropdownMenuItem onClick={() => jsonlFileInputRef.current?.click()}>
            <FileUp className="mr-2 h-4 w-4" />
            Import JSONL
          </DropdownMenuItem>
          <DropdownMenuItem onClick={() => setIsJsonlDialogOpen(true)}>
            <FileText className="mr-2 h-4 w-4" />
            Enter JSONL
          </DropdownMenuItem>
          <DropdownMenuItem onClick={() => setIsDeleteDialogOpen(true)}>
            <Trash className="mr-2 h-4 w-4 text-red-500" />
            Delete
          </DropdownMenuItem>
          <DropdownMenuSeparator />
        </DropdownMenuContent>
      </DropdownMenu>
      <Input
        ref={jsonlFileInputRef}
        id={`jsonl-file-upload-${treePath}`}
        type="file"
        className="hidden"
        onChange={handleJsonlFileSelected}
        accept=".jsonl,.jsonlines"
        disabled={isLoadingJsonlFile || applyJsonlMutation.isPending}
      />
      <Dialog open={isDeleteDialogOpen} onOpenChange={setIsDeleteDialogOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Delete Tree</DialogTitle>
          </DialogHeader>
          <form onSubmit={handleDelete}>
            <DialogDescription>
              Are you sure you want to delete this tree?
            </DialogDescription>
            <DialogFooter>
              <Button
                variant="outline"
                onClick={() => setIsDeleteDialogOpen(false)}
              >
                Cancel
              </Button>
              <Button variant="destructive" type="submit">
                Delete
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
      <Dialog open={isJsonlDialogOpen} onOpenChange={setIsJsonlDialogOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Import JSONL</DialogTitle>
          </DialogHeader>
          <form onSubmit={handleJsonlTextSubmit}>
            <Textarea
              placeholder='{"key": "myKey1", "value": "myValue1"}\n{"key": "myKey2", "value": "myValue2"}'
              value={jsonlText}
              onChange={(e) => setJsonlText(e.target.value)}
              rows={5}
              disabled={applyJsonlMutation.isPending}
              className="font-mono text-xs"
            />
            <DialogFooter>
              <Button
                variant="outline"
                onClick={() => setIsJsonlDialogOpen(false)}
              >
                Cancel
              </Button>
              <Button variant="default" type="submit">
                Import
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </>
  );
}

// src/components/treeOperations/BasicOpsComponent.tsx
import React, { useState } from "react";
import { type WasmProllyTree } from "prolly-wasm";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Loader2, CheckCircle, Search, Trash2, FileDown } from "lucide-react";

import {
  generateTreeFilename,
  toU8,
  triggerBrowserDownload,
  u8ToString,
} from "@/lib/prollyUtils";
import { toast } from "sonner";
import { useProllyStore } from "@/useProllyStore";
import { useMutation } from "@tanstack/react-query";
import { Separator } from "@radix-ui/react-separator";

interface BasicOpsProps {
  tree: WasmProllyTree;
  treePath: string;
}

export const BasicOpsComponent: React.FC<BasicOpsProps> = ({
  tree,
  treePath,
}) => {
  const [insertKey, setInsertKey] = useState("");
  const [insertValue, setInsertValue] = useState("");
  const [getKey, setGetKey] = useState("");
  const [deleteKeyInput, setDeleteKeyInput] = useState(""); // Renamed to avoid conflict

  const insertMutation = useMutation({
    mutationFn: async () => {
      await tree.insert(toU8(insertKey), toU8(insertValue));
      useProllyStore.getState().treeUpdated(treePath);
      toast.success(`Inserted "${insertKey}"`);
    },
  });

  const deleteMutation = useMutation({
    mutationFn: async () => {
      await tree.delete(toU8(deleteKeyInput));
      useProllyStore.getState().treeUpdated(treePath);
      toast.success(`Deleted "${deleteKeyInput}"`);
    },
  });

  const handleGet = async () => {
    const value = await tree.get(toU8(getKey));
    const valueString = value ? u8ToString(value) : "null";
    toast.success(`Value for "${getKey}": ${valueString}`);
  };

  return (
    <div className="space-y-4 flex flex-col gap-4">
      <div className="space-y-2">
        <h4 className="font-medium text-sm">Insert / Update Key-Value</h4>
        <div className="flex flex-col sm:flex-row gap-2">
          <Input
            placeholder="Key"
            value={insertKey}
            onChange={(e) => setInsertKey(e.target.value)}
            disabled={insertMutation.isPending}
          />
          <Input
            placeholder="Value"
            value={insertValue}
            onChange={(e) => setInsertValue(e.target.value)}
            disabled={insertMutation.isPending}
          />
          <Button
            onClick={() => insertMutation.mutate()}
            disabled={insertMutation.isPending || !insertKey}
            className="w-full sm:w-auto"
          >
            {insertMutation.isPending ? (
              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
            ) : (
              <CheckCircle className="mr-2 h-4 w-4" />
            )}{" "}
            Insert
          </Button>
        </div>
      </div>
      <div className="space-y-2">
        <h4 className="font-medium text-sm">Get Value by Key</h4>
        <div className="flex flex-col sm:flex-row gap-2">
          <Input
            placeholder="Key"
            value={getKey}
            onChange={(e) => setGetKey(e.target.value)}
          />
          <Button
            onClick={handleGet}
            disabled={!getKey}
            className="w-full sm:w-auto"
          >
            <Search className="mr-2 h-4 w-4" />
            Get
          </Button>
        </div>
      </div>
      <div className="space-y-2">
        <h4 className="font-medium text-sm">Delete Key</h4>
        <div className="flex flex-col sm:flex-row gap-2">
          <Input
            placeholder="Key"
            value={deleteKeyInput}
            onChange={(e) => setDeleteKeyInput(e.target.value)}
            disabled={deleteMutation.isPending}
          />
          <Button
            onClick={() => deleteMutation.mutate()}
            variant="destructive"
            disabled={deleteMutation.isPending || !deleteKeyInput}
            className="w-full sm:w-auto"
          >
            {deleteMutation.isPending ? (
              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
            ) : (
              <Trash2 className="mr-2 h-4 w-4" />
            )}{" "}
            Delete
          </Button>
        </div>
      </div>
    </div>
  );
};

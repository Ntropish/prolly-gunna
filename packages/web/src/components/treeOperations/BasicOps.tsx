// src/components/treeOperations/BasicOpsComponent.tsx
import React, { useState } from "react";
import { type WasmProllyTree } from "prolly-wasm";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Loader2, CheckCircle, Search, Trash2 } from "lucide-react";
import {
  useInsertItemMutation,
  useGetItemMutation,
  useDeleteItemMutation,
} from "@/hooks/useTreeMutations"; // Adjust path as needed

interface BasicOpsProps {
  tree: WasmProllyTree;
  treeId: string;
}

export const BasicOpsComponent: React.FC<BasicOpsProps> = ({
  tree,
  treeId,
}) => {
  const [insertKey, setInsertKey] = useState("");
  const [insertValue, setInsertValue] = useState("");
  const [getKey, setGetKey] = useState("");
  const [deleteKeyInput, setDeleteKeyInput] = useState(""); // Renamed to avoid conflict

  const insertMutation = useInsertItemMutation();
  const getMutation = useGetItemMutation();
  const deleteMutation = useDeleteItemMutation();

  const handleInsert = () => {
    insertMutation.mutate(
      { treeId, tree, key: insertKey, value: insertValue },
      {
        onSuccess: () => {
          setInsertKey("");
          setInsertValue("");
        },
      }
    );
  };

  const handleGet = () => {
    getMutation.mutate(
      { treeId, tree, key: getKey },
      {
        onSuccess: () => {
          setGetKey("");
        },
      }
    );
  };

  const handleDelete = () => {
    deleteMutation.mutate(
      { treeId, tree, key: deleteKeyInput },
      {
        onSuccess: () => {
          setDeleteKeyInput("");
        },
      }
    );
  };

  return (
    <>
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
            onClick={handleInsert}
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
            disabled={getMutation.isPending}
          />
          <Button
            onClick={handleGet}
            disabled={getMutation.isPending || !getKey}
            className="w-full sm:w-auto"
          >
            {getMutation.isPending ? (
              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
            ) : (
              <Search className="mr-2 h-4 w-4" />
            )}{" "}
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
            onClick={handleDelete}
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
    </>
  );
};

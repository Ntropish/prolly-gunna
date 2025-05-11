// src/components/treeOperations/BasicOpsComponent.tsx
import React, { useState } from "react";
import { type OperationProps } from "./common";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Loader2, CheckCircle, Search, Trash2 } from "lucide-react";
import { toU8, u8ToString } from "@/lib/prollyUtils";
import { toast } from "sonner";

export const BasicOpsComponent: React.FC<OperationProps> = ({
  tree,
  setLoading,
  loadingStates,
  refreshRootHash,
  updateTreeStoreState,
}) => {
  const [insertKey, setInsertKey] = useState("");
  const [insertValue, setInsertValue] = useState("");
  const [getKey, setGetKey] = useState("");
  const [deleteKey, setDeleteKey] = useState("");

  const handleInsert = async () => {
    if (!insertKey) {
      toast.error("Insert key cannot be empty.");
      return;
    }
    setLoading("insert", true);
    try {
      await tree.insert(toU8(insertKey), toU8(insertValue));
      await refreshRootHash(); // Refreshes root hash in global store
      setInsertKey("");
      setInsertValue("");
      toast.success("Insert successful.");
    } catch (e: any) {
      toast.error(e.message);
    } finally {
      setLoading("insert", false);
    }
  };

  const handleGet = async () => {
    if (!getKey) {
      //   setFeedback({ type: "error", message: "Get key cannot be empty." });
      toast.error("Get key cannot be empty.");
      return;
    }
    setLoading("get", true);
    try {
      const value = await tree.get(toU8(getKey));
      // Update a more general display area in TreeInterface rather than local lastValue
      updateTreeStoreState({
        lastValue: value ? u8ToString(value) : "null (not found)",
      });

      toast.success(
        `Value for "${getKey}": ${value ? u8ToString(value) : "not found"}`
      );
      setGetKey("");
    } catch (e: any) {
      toast.error(e.message);
    } finally {
      setLoading("get", false);
    }
  };

  const handleDelete = async () => {
    if (!deleteKey) {
      toast.error("Delete key cannot be empty.");
      return;
    }
    setLoading("delete", true);
    try {
      const deleted = await tree.delete(toU8(deleteKey));
      await refreshRootHash();
      toast.success(
        deleted ? "Delete successful." : "Delete failed (key not found)."
      );
      setDeleteKey("");
    } catch (e: any) {
      toast.error(e.message);
    } finally {
      setLoading("delete", false);
    }
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
            disabled={loadingStates.insert}
          />
          <Input
            placeholder="Value"
            value={insertValue}
            onChange={(e) => setInsertValue(e.target.value)}
            disabled={loadingStates.insert}
          />
          <Button
            onClick={handleInsert}
            disabled={loadingStates.insert || !insertKey}
            className="w-full sm:w-auto"
          >
            {loadingStates.insert ? (
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
            disabled={loadingStates.get}
          />
          <Button
            onClick={handleGet}
            disabled={loadingStates.get || !getKey}
            className="w-full sm:w-auto"
          >
            {loadingStates.get ? (
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
            value={deleteKey}
            onChange={(e) => setDeleteKey(e.target.value)}
            disabled={loadingStates.delete}
          />
          <Button
            onClick={handleDelete}
            variant="destructive"
            disabled={loadingStates.delete || !deleteKey}
            className="w-full sm:w-auto"
          >
            {loadingStates.delete ? (
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

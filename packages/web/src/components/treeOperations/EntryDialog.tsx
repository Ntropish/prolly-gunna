import type { ProllyTree } from "@/useProllyStore";

import { useMutation } from "@tanstack/react-query";
import { useProllyStore } from "@/useProllyStore";
import { Button } from "../ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "../ui/dialog";
import { useEffect, useRef, useState } from "react";
import { Input } from "../ui/input";
import { toU8, u8ToString } from "@/lib/prollyUtils";
import { toast } from "sonner";
import { CirclePlus, Key } from "lucide-react";
import { Textarea } from "../ui/textarea";

export interface EntryDialogProps {
  prly: ProllyTree | null;
  entryKey: string | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function EntryDialog({
  prly,
  entryKey,
  open,
  onOpenChange,
}: EntryDialogProps) {
  const [newKey, setNewKey] = useState<string | undefined>("");
  const [value, setValue] = useState<string | undefined>("");

  const hasNewKey = newKey !== entryKey;

  const isOpenRef = useRef(open);
  useEffect(() => {
    async function fetchValue() {
      if (open && !isOpenRef.current) {
        setNewKey(entryKey ?? "");
        setValue(u8ToString(await prly?.tree.get(toU8(entryKey ?? ""))));
      }
      isOpenRef.current = open;
    }
    fetchValue();
  }, [open, entryKey, prly]);

  const { mutate: updateEntry, isPending } = useMutation({
    mutationFn: async (entry: {
      key: string;
      value: string;
      newKey?: string;
    }) => {
      let insertEntry = { key: entry.key, value: entry.value };

      console.log("updating entry", entry);

      const isMove = entry.newKey !== undefined && entry.newKey !== entry.key;
      if (isMove) {
        // Verify that the key is not already in the tree
        const existingEntry = await prly?.tree.get(toU8(entry.newKey!));
        if (existingEntry) {
          throw new Error("Key already in tree");
        }
        insertEntry = { key: entry.newKey!, value: entry.value };
      }

      // Add the new entry
      await prly?.tree.insert(toU8(insertEntry.key), toU8(insertEntry.value));

      if (isMove) {
        console.log("moving entry", entry.key, entry.newKey);
        // Remove the old entry
        await prly?.tree.delete(toU8(entry.key));
      }
    },
    onSuccess: () => {
      onOpenChange(false);
      toast.success("Entry updated");
      useProllyStore.getState().treeUpdated(prly?.path ?? "");
    },
    onError: (error) => {
      toast.error(error.message);
    },
  });

  const { mutate: cloneEntry, isPending: isCloning } = useMutation({
    mutationFn: async (entry: { key: string; newKey: string }) => {
      const sourceEntry = await prly?.tree.get(toU8(entry.key));
      if (!sourceEntry) {
        throw new Error("Entry not found");
      }
      // Verify that the key is not already in the tree
      const existingEntry = await prly?.tree.get(toU8(entry.newKey));
      if (existingEntry) {
        throw new Error("Key already in tree");
      }

      console.log("cloning entry", entry.newKey, sourceEntry);
      await prly?.tree.insert(toU8(entry.newKey), sourceEntry);
    },
    onSuccess: () => {
      toast.success("Entry cloned");
      useProllyStore.getState().treeUpdated(prly?.path ?? "");
    },
    onError: (error) => {
      toast.error(error.message);
    },
  });

  const { mutate: deleteEntry, isPending: isDeleting } = useMutation({
    mutationFn: async (entry: { key: string }) => {
      await prly?.tree.delete(toU8(entry.key));
    },
    onSuccess: () => {
      toast.success("Entry deleted");
      onOpenChange(false);
      useProllyStore.getState().treeUpdated(prly?.path ?? "");
    },
    onError: (error) => {
      toast.error(error.message);
    },
  });

  const handleSubmit = (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    console.log("updating entry", newKey, value);
    updateEntry({ key: entryKey!, value: value!, newKey: newKey! });
  };

  const handleClone = (e: React.MouseEvent<HTMLButtonElement>) => {
    e.preventDefault();
    cloneEntry({ key: entryKey!, newKey: newKey! });
  };

  const handleDelete = (e: React.MouseEvent<HTMLButtonElement>) => {
    e.preventDefault();
    deleteEntry({ key: entryKey! });
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle className="text-lg font-light flex items-center gap-2">
            <Key className="w-4 h-4 text-yellow-500" />
            {entryKey}
          </DialogTitle>
        </DialogHeader>

        <form onSubmit={handleSubmit} className="space-y-4">
          <Input
            type="text"
            placeholder="Key"
            name="key"
            value={newKey}
            onChange={(e) => setNewKey(e.target.value)}
          />
          <Textarea
            placeholder="Value"
            name="value"
            value={value}
            onChange={(e) => setValue(e.target.value)}
          />

          <DialogFooter className="mt-4">
            <Button
              onClick={handleDelete}
              variant="destructive"
              className="mr-auto"
            >
              Delete
            </Button>
            <Button onClick={() => onOpenChange(false)} variant="outline">
              Cancel
            </Button>
            {hasNewKey && (
              <Button
                variant="outline"
                onClick={handleClone}
                className="bg-blue-500"
              >
                Clone
              </Button>
            )}
            <Button type="submit" disabled={isPending}>
              {isPending ? "Updating..." : "Update"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

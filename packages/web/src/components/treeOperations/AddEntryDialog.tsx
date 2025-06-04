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
import { useState } from "react";
import { Input } from "../ui/input";
import { toU8 } from "@/lib/prollyUtils";
import { toast } from "sonner";
import { CirclePlus } from "lucide-react";
import { Textarea } from "../ui/textarea";

export interface AddEntryDialogProps {
  tree: ProllyTree;
}

export function AddEntryDialog({ tree }: AddEntryDialogProps) {
  const [open, setOpen] = useState(false);

  const { mutate: addEntry, isPending } = useMutation({
    mutationFn: async (entry: { key: string; value: string }) => {
      await tree.tree.insert(toU8(entry.key), toU8(entry.value));
      useProllyStore.getState().treeUpdated(tree.path);
    },
    onSuccess: () => {
      setOpen(false);
      toast.success("Entry added");
      useProllyStore.getState().treeUpdated(tree.path);
    },
    onError: (error) => {
      toast.error(error.message);
    },
  });

  const handleSubmit = (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const formData = new FormData(event.target as HTMLFormElement);
    const key = formData.get("key") as string;
    const value = formData.get("value") as string;
    addEntry({ key, value });
  };

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button variant="ghost" size="icon">
          <CirclePlus className="w-4 h-4 text-green-500" />
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle className="text-lg font-light">Add Entry</DialogTitle>
        </DialogHeader>

        <form onSubmit={handleSubmit}>
          <DialogDescription className="space-y-4">
            <Input type="text" placeholder="Key" name="key" />
            <Textarea
              placeholder="Value"
              name="value"
              className="resize-none"
            />
          </DialogDescription>

          <DialogFooter className="mt-4">
            <Button onClick={() => setOpen(false)}>Cancel</Button>
            <Button type="submit" disabled={isPending}>
              {isPending ? "Adding..." : "Add"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

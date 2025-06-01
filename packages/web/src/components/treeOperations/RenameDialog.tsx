import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";
import { useState } from "react";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { useProllyStore } from "@/useProllyStore";
import { toast } from "sonner";

interface RenameDialogProps {
  treeId: string;
  currentName: string;
}
export function RenameDialog({ treeId, currentName }: RenameDialogProps) {
  const [name, setName] = useState(currentName);
  const [open, setOpen] = useState(false);
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button variant="outline">Rename</Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Rename</DialogTitle>
        </DialogHeader>
        <DialogDescription>
          <Input value={name} onChange={(e) => setName(e.target.value)} />
        </DialogDescription>
        <DialogFooter>
          <Button variant="outline" onClick={() => setName(currentName)}>
            Cancel
          </Button>
          <Button
            onClick={() =>
              useProllyStore
                .getState()
                .renameTree(treeId, name)
                .then(() => {
                  toast.success("Tree renamed");
                  setOpen(false);
                })
                .catch((err) => {
                  toast.error(`Failed to rename tree: ${err.message}`);
                })
            }
          >
            Rename
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

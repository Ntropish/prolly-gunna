import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarHeader,
  SidebarMenuButton,
  SidebarMenuItem,
} from "@/components/ui/sidebar";
import { useProllyStore } from "@/useProllyStore";
import { Link, useLocation, useNavigate } from "react-router";
import { Button } from "./ui/button";
import { useRef, type ChangeEvent } from "react";
import { useState } from "react";
import { toast } from "sonner";
import { WasmProllyTree } from "prolly-wasm";
import { PlusCircle } from "lucide-react";
import { Label } from "@radix-ui/react-label";
import { Loader2, FileUp, TreeDeciduous } from "lucide-react";
import { Input } from "./ui/input";
import { TreeMenu } from "./tree-menu";

export function AppSidebar() {
  const trees = useProllyStore((s) => s.trees);
  const location = useLocation();
  const navigate = useNavigate();

  const [working, setWorking] = useState<"create" | "load" | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  async function createNewTree() {
    setWorking("create");
    try {
      const id = await useProllyStore.getState().createNewTree();
      toast.success(`Created "${id}" (unsaved)`);
      navigate(`/${id}`);
    } catch (err: any) {
      toast.error(`New tree failed: ${err.message ?? "Unknown"}`);
    } finally {
      setWorking(null);
    }
  }

  async function updloadTreeFromFile(file: File) {
    setWorking("load");
    try {
      const bytes = new Uint8Array(await file.arrayBuffer());
      const tree = await WasmProllyTree.loadTreeFromFileBytes(bytes);
      const path = file.name;

      const id = await useProllyStore.getState().createNewTree({
        tree,
        path,
      });

      toast.success(`Loaded "${file.name}"`);
      navigate(`/${id}`);
    } catch (err: any) {
      toast.error(`Load failed: ${err.message ?? "Unknown"}`);
    } finally {
      setWorking(null);
      if (fileInputRef.current) fileInputRef.current.value = "";
    }
  }

  function onFileChosen(e: ChangeEvent<HTMLInputElement>) {
    const f = e.target.files?.[0];
    if (f) updloadTreeFromFile(f);
  }

  return (
    <Sidebar>
      <SidebarHeader>
        <div className="flex gap-2 flex-wrap justify-center sm:justify-end">
          <Button
            size="sm"
            onClick={createNewTree}
            disabled={working === "create"}
          >
            {working === "create" ? (
              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
            ) : (
              <PlusCircle className="mr-2 h-4 w-4" />
            )}
            New Tree
          </Button>

          <Label htmlFor="file-upload" className="cursor-pointer">
            <Button
              asChild
              size="sm"
              variant="outline"
              disabled={working === "load"}
            >
              <span>
                {working === "load" ? (
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                ) : (
                  <FileUp className="mr-2 h-4 w-4" />
                )}
                Load Tree
              </span>
            </Button>
          </Label>
          <Input
            id="file-upload"
            ref={fileInputRef}
            type="file"
            accept=".prly,.prollytree,.prolly"
            className="hidden"
            onChange={onFileChosen}
            disabled={working === "load"}
          />
        </div>
      </SidebarHeader>
      <SidebarContent>
        <SidebarGroup className="list-none">
          {Object.entries(trees)
            .sort((a, b) => a[1].path.localeCompare(b[1].path))
            .map(([id, tree]) => (
              <SidebarMenuItem key={id}>
                <div className="flex flex-row">
                  <SidebarMenuButton
                    asChild
                    isActive={location.pathname === `/${id}`}
                  >
                    <Link to={`/${tree.path}`} className="flex justify-between">
                      <span className="text-xs text-overflow-ellipsis overflow-hidden font-mono">
                        {tree.path.replace(/\.prly$/, "")}
                      </span>
                      {tree.rootHash !== tree.lastSavedRootHash && "*"}
                    </Link>
                  </SidebarMenuButton>
                  <div className="flex justify-end">
                    <TreeMenu prly={tree} treePath={tree.path} />
                  </div>
                </div>
              </SidebarMenuItem>
            ))}
        </SidebarGroup>
        <SidebarGroup />
      </SidebarContent>
      <SidebarFooter />
    </Sidebar>
  );
}

// src/App.tsx
import { useEffect, useState, type ChangeEvent, useRef, useMemo } from "react";
import { WasmProllyTree } from "prolly-wasm";
import { u8ToHex } from "@/lib/prollyUtils";

import { useProllyStore } from "@/useProllyStore"; //  ← NEW STORE
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { ScrollArea } from "@/components/ui/scroll-area";
import { TreeInterface } from "@/components/TreeInterface";
import { Toaster, toast } from "sonner";
import { Loader2, FileUp, PlusCircle, TreeDeciduous } from "lucide-react";

export default function App() {
  // ────────────────────────────────────────────────────────────
  //  1.  Store selectors
  // ────────────────────────────────────────────────────────────
  const treesList = useProllyStore((s) => s.trees);
  const trees = useMemo(
    () =>
      Object.values(treesList).map((tree) => ({
        ...tree,
      })),
    [treesList]
  );
  const initializing = useProllyStore((s) => s.initializing);

  // ────────────────────────────────────────────────────────────
  //  2.  UI state
  // ────────────────────────────────────────────────────────────
  const [activeTab, setActiveTab] = useState<string>();
  const [working, setWorking] = useState<"create" | "load" | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // keep activeTab valid
  useEffect(() => {
    if (!activeTab && trees.length) setActiveTab(trees[0].id);
    if (activeTab && !trees.find((t) => t.id === activeTab))
      setActiveTab(trees.length ? trees[0].id : undefined);
  }, [trees, activeTab]);

  // ────────────────────────────────────────────────────────────
  //  3.  Light helpers – push into store if you prefer
  // ────────────────────────────────────────────────────────────
  async function createNewTree() {
    setWorking("create");
    try {
      const id = await useProllyStore.getState().createNewTree();
      toast.success(`Created "${id}" (unsaved)`);
      setActiveTab(id);
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

      // useProllyStore.setState((s) => ({
      //   trees: {
      //     ...s.trees,
      //     [id]: {
      //       id,
      //       tree,
      //       treeConfig: cfg as any,
      //       rootHash: root ? u8ToHex(root) : null,
      //       lastSavedRootHash: root ? u8ToHex(root) : null,
      //       isDirty: false,
      //       fileHandle: null, // not linked to OPFS yet
      //       lastError: null,
      //       lastValue: null,
      //       items: [],
      //       chunks: [],
      //       diffResult: [],
      //       gcCollectedCount: null,
      //     },
      //   },
      // }));
      toast.success(`Loaded "${file.name}"`);
      setActiveTab(id);
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

  // ────────────────────────────────────────────────────────────
  //  4.  Render
  // ────────────────────────────────────────────────────────────
  return (
    <div className="container mx-auto p-4 sm:p-6 space-y-6 min-h-screen">
      <Toaster richColors />

      {/* HEADER */}
      <header className="flex flex-col sm:flex-row justify-between items-center gap-4 pb-6 border-b">
        <div className="flex items-center gap-2">
          <TreeDeciduous className="h-8 w-8 text-primary" />
          <h1 className="text-3xl font-bold tracking-tight">Prolly Tree Web</h1>
        </div>

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
      </header>

      {/* BODY */}
      {initializing ? (
        <div className="flex justify-center py-16">
          <Loader2 className="h-10 w-10 animate-spin" />
        </div>
      ) : trees.length === 0 ? (
        <div className="text-center py-12">
          <TreeDeciduous className="mx-auto h-16 w-16 text-muted-foreground/50" />
          <h2 className="mt-4 text-xl font-semibold text-muted-foreground">
            No Trees Available
          </h2>
          <p className="text-muted-foreground mt-2">
            Create a new tree or load one from a file to begin.
          </p>
        </div>
      ) : (
        <Tabs value={activeTab} onValueChange={setActiveTab} className="w-full">
          <ScrollArea className="pb-2 -mx-1">
            <TabsList className="inline-flex h-auto bg-muted p-1 rounded-lg">
              {trees.map((t) => (
                <TabsTrigger
                  key={t.id}
                  value={t.id}
                  className="text-xs sm:text-sm data-[state=active]:bg-background data-[state=active]:text-foreground data-[state=active]:shadow-sm px-3 py-1.5"
                >
                  {t.id.length > 18 ? `${t.id.slice(0, 18)}…` : t.id}
                  {t.rootHash !== t.lastSavedRootHash && "*"}
                </TabsTrigger>
              ))}
            </TabsList>
          </ScrollArea>

          {trees.map((t) => (
            <TabsContent key={t.id} value={t.id} className="mt-4">
              <TreeInterface treeState={t} />
            </TabsContent>
          ))}
        </Tabs>
      )}
    </div>
  );
}

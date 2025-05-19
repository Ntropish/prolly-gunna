import "./App.css";
import React, { useState, useEffect, type ChangeEvent, useRef } from "react";
import { WasmProllyTree } from "prolly-wasm"; // Ensure this import path is correct
import {
  useAppStore,
  type TreeState,
  type JsTreeConfigType,
} from "./useAppStore";
import { Button } from "./components/ui/button";
import { Input } from "./components/ui/input";
import { Label } from "./components/ui/label";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "./components/ui/tabs";
import { ScrollArea } from "./components/ui/scroll-area";
import { TreeInterface } from "./components/TreeInterface";
import {
  Loader2,
  FileUp,
  PlusCircle,
  // XCircle, // No longer used from here if Alert is commented out
  TreeDeciduous,
} from "lucide-react";
import {
  u8ToHex,
  hexToU8, // Still needed if you manually create rootHash for display from loaded hex
  // u8ToString,     // No longer needed here for parsing
} from "@/lib/prollyUtils"; // Adjust path if necessary
import { Toaster, toast } from "sonner";

function App() {
  const { trees, addTree } = useAppStore();
  const [activeTab, setActiveTab] = useState<string | undefined>(undefined);

  const [isCreatingTree, setIsCreatingTree] = useState(false);
  const [isLoadingFile, setIsLoadingFile] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (
      (!activeTab && trees.length > 0) ||
      (activeTab && !trees.find((t) => t.id === activeTab) && trees.length > 0)
    ) {
      setActiveTab(trees[0].id);
    } else if (trees.length === 0) {
      setActiveTab(undefined);
    }
  }, [trees, activeTab]);

  const handleCreateTree = async () => {
    setIsCreatingTree(true);
    // setGlobalFeedback(null); // If using globalFeedback
    const newTree = new WasmProllyTree();
    const treeId = `Tree-${Date.now().toString().slice(-5)}`;
    try {
      const rootHashU8 = await newTree.getRootHash(); // This is Uint8Array | null
      const treeConfigFromWasm = await newTree.getTreeConfig();

      // console.log(
      //   "DEBUG: Raw treeConfigFromWasm (create):",
      //   JSON.stringify(treeConfigFromWasm, null, 2)
      // );

      const treeConfig = treeConfigFromWasm as JsTreeConfigType;

      if (!treeConfig || typeof treeConfig.targetFanout !== "number") {
        // console.error(
        //   "DEBUG: Validation failed (create)! treeConfig object:",
        //   treeConfig,
        //   "| typeof treeConfig:",
        //   typeof treeConfig,
        //   "| treeConfig.targetFanout:",
        //   treeConfig?.targetFanout,
        //   "| typeof treeConfig.targetFanout:",
        //   typeof treeConfig?.targetFanout
        // );
        throw new Error(
          "Failed to obtain valid tree configuration from new Wasm tree."
        );
      }

      const newTreeState: TreeState = {
        id: treeId,
        tree: newTree,
        rootHash: rootHashU8 ? u8ToHex(rootHashU8) : null, // Handle null rootHash
        treeConfig: treeConfig,
        lastError: null,
        lastValue: null,
        items: [],
        chunks: [],
        diffResult: [],
        gcCollectedCount: null,
      };
      addTree(newTreeState);
      toast.success(`Tree "${treeId}" created successfully.`);
      setActiveTab(treeId);
    } catch (e: any) {
      console.error("Failed to initialize tree:", e);
      toast.error(`Failed to create tree: ${e.message || "Unknown error"}`);
    } finally {
      setIsCreatingTree(false);
    }
  };

  // MODIFIED processAndLoadFile function
  const processAndLoadFile = async (file: File) => {
    setIsLoadingFile(true);
    // setGlobalFeedback(null); // If using globalFeedback

    try {
      const fileBuffer = await file.arrayBuffer();
      const fileBytes = new Uint8Array(fileBuffer);

      // Call the Wasm function to load the tree from bytes
      // This function is now static on WasmProllyTree
      const newLoadedTreeInstance = await WasmProllyTree.loadTreeFromFileBytes(
        fileBytes
      );

      // After successfully loading, get necessary info from the instance
      const rootHashU8FromWasm = await newLoadedTreeInstance.getRootHash(); // Returns Promise<Uint8Array | null>
      const treeConfigFromWasm = await newLoadedTreeInstance.getTreeConfig(); // Returns Promise<JsTreeConfigType>

      // console.log(
      //   "DEBUG: Raw treeConfigFromWasm (load):",
      //   JSON.stringify(treeConfigFromWasm, null, 2)
      // );

      const loadedTreeConfig = treeConfigFromWasm as JsTreeConfigType;

      if (
        !loadedTreeConfig ||
        typeof loadedTreeConfig.targetFanout !== "number"
      ) {
        // console.error(
        //   "DEBUG: Validation failed (load)! treeConfig object:",
        //   loadedTreeConfig
        // );
        throw new Error(
          "Failed to obtain valid tree configuration from loaded Wasm tree."
        );
      }

      const loadedRootHashHex = rootHashU8FromWasm
        ? u8ToHex(rootHashU8FromWasm)
        : null;

      const treeId = `loaded-${file.name
        .replace(/[^a-z0-9_.-]/gi, "_")
        .substring(0, 15)}-${Date.now().toString().slice(-4)}`;

      const newTreeState: TreeState = {
        id: treeId,
        tree: newLoadedTreeInstance,
        rootHash: loadedRootHashHex,
        treeConfig: loadedTreeConfig,
        lastError: null,
        lastValue: null,
        items: [], // Items will be populated by UI interactions
        chunks: [], // Chunks will be populated by UI interactions
        diffResult: [],
        gcCollectedCount: null,
      };

      addTree(newTreeState);
      toast.success(`Tree "${file.name}" loaded as "${treeId}".`);
      setActiveTab(treeId);
    } catch (e: any) {
      console.error("Failed to load tree from file:", e);
      toast.error(`Load failed: ${e.message || "Wasm error during load"}`);
    } finally {
      setIsLoadingFile(false);
      if (fileInputRef.current) fileInputRef.current.value = ""; // Clear file input
    }
  };

  const handleFileSelected = (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (file) {
      processAndLoadFile(file);
    }
  };

  return (
    <div className="container mx-auto p-4 sm:p-6 space-y-6 min-h-screen">
      <Toaster richColors />
      <header className="flex flex-col sm:flex-row justify-between items-center gap-4 pb-6 border-b">
        {/* ... Header content (unchanged) ... */}
        <div className="flex items-center gap-2">
          <TreeDeciduous className="h-8 w-8 text-primary" />
          <h1 className="text-3xl font-bold tracking-tight">Prolly Tree Web</h1>
        </div>
        <div className="flex gap-2 flex-wrap justify-center sm:justify-end">
          <Button
            onClick={handleCreateTree}
            disabled={isCreatingTree}
            size="sm"
          >
            {isCreatingTree ? (
              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
            ) : (
              <PlusCircle className="mr-2 h-4 w-4" />
            )}
            New Tree
          </Button>
          <Label htmlFor="file-upload" className="cursor-pointer">
            <Button
              asChild
              variant="outline"
              disabled={isLoadingFile}
              size="sm"
            >
              <span>
                {isLoadingFile ? (
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                ) : (
                  <FileUp className="mr-2 h-4 w-4" />
                )}
                Load Tree
              </span>
            </Button>
          </Label>
          <Input
            ref={fileInputRef}
            id="file-upload"
            type="file"
            className="hidden"
            onChange={handleFileSelected}
            accept=".prly,.prollytree,.prolly" // Keep or adjust accepted file types
            disabled={isLoadingFile}
          />
        </div>
      </header>

      {/* ... Global feedback alert (commented out, can be restored if needed) ... */}

      {trees.length === 0 && !isLoadingFile && !isCreatingTree ? (
        // ... Placeholder for no trees (unchanged) ...
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
            {" "}
            <TabsList className="inline-flex h-auto bg-muted p-1 rounded-lg">
              {trees.map((t) => (
                <TabsTrigger
                  key={t.id}
                  value={t.id}
                  className="text-xs sm:text-sm data-[state=active]:bg-background data-[state=active]:text-foreground data-[state=active]:shadow-sm px-3 py-1.5"
                >
                  {t.id.length > 18 ? `${t.id.substring(0, 18)}...` : t.id}
                </TabsTrigger>
              ))}
            </TabsList>
          </ScrollArea>
          {trees.map((treeState) => (
            <TabsContent
              key={treeState.id}
              value={treeState.id}
              className="mt-4 rounded-lg "
            >
              {" "}
              <TreeInterface treeState={treeState} />
            </TabsContent>
          ))}
        </Tabs>
      )}
    </div>
  );
}
export default App;

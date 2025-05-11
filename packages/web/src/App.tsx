import "./App.css";
import React, { useState, useEffect, type ChangeEvent, useRef } from "react";
import { WasmProllyTree } from "prolly-wasm";
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
  XCircle,
  TreeDeciduous,
} from "lucide-react";
import {
  FILE_SIGNATURE,
  FILE_VERSION,
  TAG_METADATA,
  TAG_CHUNK,
  u8ToHex,
  hexToU8,
  u8ToString,
} from "@/lib/prollyUtils";
import { CheckCircle } from "lucide-react";
import { Toaster, toast } from "sonner";

function App() {
  const { trees, addTree } = useAppStore();
  const [activeTab, setActiveTab] = useState<string | undefined>(undefined);
  const [globalFeedback, setGlobalFeedback] = useState<{
    type: "success" | "error";
    message: string;
  } | null>(null);
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

  useEffect(() => {
    if (globalFeedback) {
      const timer = setTimeout(() => setGlobalFeedback(null), 7000);
      return () => clearTimeout(timer);
    }
  }, [globalFeedback]);

  const handleCreateTree = async () => {
    setIsCreatingTree(true);
    setGlobalFeedback(null);
    const newTree = new WasmProllyTree();
    const treeId = `Tree-${Date.now().toString().slice(-5)}`;
    try {
      const rootHashU8 = await newTree.getRootHash();
      const treeConfigFromWasm = await newTree.getTreeConfig(); // Expect JS object if wasm-bindgen marshals it

      console.log(
        "DEBUG: Raw treeConfigFromWasm:",
        JSON.stringify(treeConfigFromWasm, null, 2)
      );

      const treeConfig = treeConfigFromWasm as JsTreeConfigType; // Direct cast

      if (!treeConfig || typeof treeConfig.targetFanout !== "number") {
        console.error(
          "DEBUG: Validation failed! treeConfig object:",
          treeConfig,
          "| typeof treeConfig:",
          typeof treeConfig,
          "| treeConfig.targetFanout:",
          treeConfig?.targetFanout, // Optional chaining for safety
          "| typeof treeConfig.targetFanout:",
          typeof treeConfig?.targetFanout
        );
        throw new Error(
          "Failed to obtain valid tree configuration from new Wasm tree."
        );
      }

      const newTreeState: TreeState = {
        id: treeId,
        tree: newTree,
        rootHash: u8ToHex(rootHashU8),
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

  const processAndLoadFile = async (file: File) => {
    setIsLoadingFile(true);
    setGlobalFeedback(null);
    try {
      const fileBuffer = await file.arrayBuffer();
      const fileBytes = new Uint8Array(fileBuffer);
      const view = new DataView(fileBytes.buffer);
      let offset = 0;

      const signature = u8ToString(
        fileBytes.slice(offset, offset + FILE_SIGNATURE.length)
      );
      offset += FILE_SIGNATURE.length;
      if (signature !== FILE_SIGNATURE)
        throw new Error("Invalid file signature. Expected 'PRLYTRE1'.");

      const version = view.getUint8(offset);
      offset += 1;
      if (version !== FILE_VERSION)
        throw new Error(
          `Unsupported file version. Expected ${FILE_VERSION}, got ${version}.`
        );

      const metadataTag = view.getUint8(offset);
      offset += 1;
      if (metadataTag !== TAG_METADATA)
        throw new Error("Metadata block tag not found or out of order.");

      const metadataLength = view.getUint32(offset, true);
      offset += 4;
      if (offset + metadataLength > fileBytes.byteLength)
        throw new Error("Metadata length exceeds file size.");
      const metadataJsonBytes = fileBytes.slice(
        offset,
        offset + metadataLength
      );
      offset += metadataLength;
      const metadataJsonString = u8ToString(metadataJsonBytes);
      const loadedMetadata = JSON.parse(metadataJsonString) as {
        rootHash: string | null;
        treeConfig: JsTreeConfigType;
        createdAt: string;
        chunkCount: number;
      };

      if (
        typeof loadedMetadata.chunkCount !== "number" ||
        !loadedMetadata.treeConfig
      ) {
        throw new Error(
          "File metadata is incomplete or malformed (missing chunkCount or treeConfig)."
        );
      }

      const rootHashU8 = loadedMetadata.rootHash
        ? hexToU8(loadedMetadata.rootHash)
        : null;
      if (loadedMetadata.rootHash && !rootHashU8) {
        throw new Error(
          `Invalid rootHash hex string in file: ${loadedMetadata.rootHash}`
        );
      }

      const loadedChunksMap = new Map<Uint8Array, Uint8Array>();
      for (let i = 0; i < loadedMetadata.chunkCount; i++) {
        if (offset + 1 > fileBytes.byteLength)
          throw new Error(`EOF before chunk ${i} tag.`);
        const chunkTag = view.getUint8(offset);
        offset += 1;
        if (chunkTag !== TAG_CHUNK)
          throw new Error(
            `Expected chunk tag for chunk ${i}, got ${chunkTag}.`
          );

        if (offset + 4 > fileBytes.byteLength)
          throw new Error(`EOF before chunk ${i} length.`);
        const chunkEntryLength = view.getUint32(offset, true);
        offset += 4;
        if (chunkEntryLength < 32)
          throw new Error(`Invalid chunk entry length for chunk ${i}.`);

        if (offset + 32 > fileBytes.byteLength)
          throw new Error(`EOF before chunk ${i} hash.`);
        const chunkHashBytes = fileBytes.slice(offset, offset + 32);
        offset += 32;

        const chunkDataLength = chunkEntryLength - 32;
        if (offset + chunkDataLength > fileBytes.byteLength)
          throw new Error(
            `EOF for chunk ${i} data (expected ${chunkDataLength} bytes, found ${
              fileBytes.byteLength - offset
            }).`
          );
        const chunkDataBytes = fileBytes.slice(
          offset,
          offset + chunkDataLength
        );
        offset += chunkDataLength;
        loadedChunksMap.set(chunkHashBytes, chunkDataBytes);
      }

      // Pass the JS object `loadedMetadata.treeConfig` directly.
      const newLoadedTreeInstance = await WasmProllyTree.load(
        rootHashU8,
        loadedChunksMap,
        loadedMetadata.treeConfig as any
      );

      const treeId = `loaded-${file.name
        .replace(/[^a-z0-9_.-]/gi, "_")
        .substring(0, 15)}-${Date.now().toString().slice(-4)}`;
      const newTreeState: TreeState = {
        id: treeId,
        tree: newLoadedTreeInstance,
        rootHash: loadedMetadata.rootHash
          ? u8ToHex(hexToU8(loadedMetadata.rootHash))
          : null,
        treeConfig: loadedMetadata.treeConfig,
        lastError: null,
        lastValue: null,
        items: [],
        chunks: [],
        diffResult: [],
        gcCollectedCount: null,
      };
      addTree(newTreeState);
      toast.success(`Tree "${file.name}" loaded as "${treeId}".`);
      setActiveTab(treeId);
    } catch (e: any) {
      console.error("Failed to load tree from file:", e);
      toast.error(`Load failed: ${e.message || "Unknown error"}`);
    } finally {
      setIsLoadingFile(false);
      if (fileInputRef.current) fileInputRef.current.value = "";
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
            accept=".prly,.prollytree,.prolly"
            disabled={isLoadingFile}
          />
        </div>
      </header>

      {/* {globalFeedback && (
        <Alert
          variant={
            globalFeedback.type === "success" ? "default" : "destructive"
          }
          className="my-4 animate-in fade-in-0 slide-in-from-top-5 duration-500"
        >
          {globalFeedback.type === "success" ? (
            <CheckCircle className="h-4 w-4" />
          ) : (
            <XCircle className="h-4 w-4" />
          )}
          <AlertTitle>
            {globalFeedback.type === "success" ? "Success" : "Error"}
          </AlertTitle>
          <AlertDescription>{globalFeedback.message}</AlertDescription>
        </Alert>
      )} */}

      {trees.length === 0 && !isLoadingFile && !isCreatingTree ? (
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
            {/* Negative margin to align with typical tab list padding */}
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
              {/* Card styling moved to TreeInterface */}
              <TreeInterface treeState={treeState} />
            </TabsContent>
          ))}
        </Tabs>
      )}
    </div>
  );
}
export default App;

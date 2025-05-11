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
import { Alert, AlertDescription, AlertTitle } from "./components/ui/alert";
import { TreeInterface } from "./components/TreeInterface";
import { Loader2, FileUp, PlusCircle, XCircle } from "lucide-react";
import {
  FILE_SIGNATURE,
  FILE_VERSION,
  TAG_METADATA,
  TAG_CHUNK,
  u8ToHex,
  hexToU8,
  u8ToString,
} from "./lib/prollyUtils";

import { CheckCircle } from "lucide-react";

function App() {
  const trees = useAppStore((state) => state.trees);
  const addTree = useAppStore((state) => state.addTree);

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

  const handleCreateTree = async () => {
    setIsCreatingTree(true);
    setGlobalFeedback(null);
    const newTree = new WasmProllyTree(); // This is synchronous
    const treeId = `tree-${Date.now()}`;
    try {
      const rootHashU8 = await newTree.getRootHash();
      const treeConfigJsValue = await newTree.getTreeConfig();
      const treeConfig = treeConfigJsValue.into_serde<JsTreeConfigType>();

      const newTreeState: TreeState = {
        id: treeId,
        tree: newTree,
        rootHash: u8ToHex(rootHashU8),
        treeConfig: treeConfig,
        lastError: null,
        lastValue: null, // Cleared to avoid showing old tree's last value
        items: [],
        chunks: [],
        diffResult: [],
        gcCollectedCount: null,
      };
      addTree(newTreeState);
      setGlobalFeedback({
        type: "success",
        message: `Tree "${treeId.substring(0, 10)}..." created successfully.`,
      });
      setActiveTab(treeId); // Switch to the newly created tree
    } catch (e: any) {
      console.error("Failed to initialize tree:", e);
      setGlobalFeedback({
        type: "error",
        message: `Failed to create tree: ${e.message}`,
      });
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
        throw new Error("Invalid file signature.");

      const version = view.getUint8(offset);
      offset += 1;
      if (version !== FILE_VERSION)
        throw new Error(
          `Unsupported file version. Expected ${FILE_VERSION}, got ${version}.`
        );

      const metadataTag = view.getUint8(offset);
      offset += 1;
      if (metadataTag !== TAG_METADATA)
        throw new Error("Metadata block not found.");

      const metadataLength = view.getUint32(offset, true);
      offset += 4;
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

      const rootHashU8 = loadedMetadata.rootHash
        ? hexToU8(loadedMetadata.rootHash)
        : null;
      if (loadedMetadata.rootHash && !rootHashU8) {
        // Check if conversion failed for a non-null hash
        throw new Error(
          `Invalid rootHash hex string in file: ${loadedMetadata.rootHash}`
        );
      }

      const loadedChunksMap = new Map<Uint8Array, Uint8Array>();
      for (let i = 0; i < loadedMetadata.chunkCount; i++) {
        if (offset + 1 > fileBytes.length)
          throw new Error(`Unexpected EOF before chunk ${i} tag.`);
        const chunkTag = view.getUint8(offset);
        offset += 1;
        if (chunkTag !== TAG_CHUNK)
          throw new Error(
            `Expected chunk tag for chunk ${i}, got ${chunkTag}.`
          );

        if (offset + 4 > fileBytes.length)
          throw new Error(`Unexpected EOF before chunk ${i} length.`);
        const chunkEntryLength = view.getUint32(offset, true);
        offset += 4;

        if (offset + 32 > fileBytes.length)
          throw new Error(`Unexpected EOF before chunk ${i} hash.`);
        const chunkHashBytes = fileBytes.slice(offset, offset + 32);
        offset += 32;

        const chunkDataLength = chunkEntryLength - 32;
        if (offset + chunkDataLength > fileBytes.length)
          throw new Error(
            `Unexpected EOF before chunk ${i} data (expected ${chunkDataLength} bytes).`
          );
        const chunkDataBytes = fileBytes.slice(
          offset,
          offset + chunkDataLength
        );
        offset += chunkDataLength;

        loadedChunksMap.set(chunkHashBytes, chunkDataBytes);
      }

      const newLoadedTreeInstance = await WasmProllyTree.load(
        rootHashU8,
        loadedChunksMap,
        loadedMetadata.treeConfig as any
      );

      const treeId = `loaded-${file.name
        .replace(/[^a-z0-9_.-]/gi, "_")
        .substring(0, 20)}-${Date.now()}`;
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
      setGlobalFeedback({
        type: "success",
        message: `Tree "${
          file.name
        }" loaded successfully as "${treeId.substring(0, 10)}...".`,
      });
      setActiveTab(treeId);
    } catch (e: any) {
      console.error("Failed to load tree from file:", e);
      setGlobalFeedback({
        type: "error",
        message: `Load failed: ${e.message || "Unknown error"}`,
      });
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
    <div className="container mx-auto p-4 space-y-6">
      <header className="flex flex-col sm:flex-row justify-between items-center gap-4 pb-4 border-b">
        <h1 className="text-3xl font-bold tracking-tight">Prolly Web UI</h1>
        <div className="flex gap-2 flex-wrap justify-center">
          <Button onClick={handleCreateTree} disabled={isCreatingTree}>
            {isCreatingTree ? (
              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
            ) : (
              <PlusCircle className="mr-2 h-4 w-4" />
            )}
            Create New Tree
          </Button>
          <Label htmlFor="file-upload" className="cursor-pointer">
            <Button asChild variant="outline" disabled={isLoadingFile}>
              <span>
                {isLoadingFile ? (
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                ) : (
                  <FileUp className="mr-2 h-4 w-4" />
                )}
                Load Tree from File
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

      {globalFeedback && (
        <Alert
          variant={
            globalFeedback.type === "success" ? "default" : "destructive"
          }
          className="my-4"
        >
          {globalFeedback.type === "success" ? (
            <CheckCircle className="h-4 w-4" />
          ) : (
            <XCircle className="h-4 w-4" />
          )}
          <AlertTitle>
            {globalFeedback.type === "success"
              ? "Operation Successful"
              : "Operation Failed"}
          </AlertTitle>
          <AlertDescription>{globalFeedback.message}</AlertDescription>
        </Alert>
      )}

      {trees.length === 0 && !isLoadingFile && !isCreatingTree ? (
        <div className="text-center py-10">
          <h2 className="text-xl font-semibold text-muted-foreground">
            No Trees Yet
          </h2>
          <p className="text-muted-foreground mt-2">
            Create a new tree or load one from a file to get started.
          </p>
        </div>
      ) : (
        <Tabs value={activeTab} onValueChange={setActiveTab} className="w-full">
          <ScrollArea className="pb-2">
            <TabsList className="inline-flex h-auto bg-muted p-1 rounded-lg">
              {trees.map((t) => (
                <TabsTrigger
                  key={t.id}
                  value={t.id}
                  className="text-xs sm:text-sm data-[state=active]:bg-background data-[state=active]:text-foreground data-[state=active]:shadow-sm"
                >
                  {t.id.length > 20 ? `${t.id.substring(0, 20)}...` : t.id}
                </TabsTrigger>
              ))}
            </TabsList>
          </ScrollArea>
          {trees.map((treeState) => (
            <TabsContent
              key={treeState.id}
              value={treeState.id}
              className="mt-0"
            >
              {" "}
              {/* Remove mt-4 if TabsList has pb-2 */}
              <TreeInterface treeState={treeState} />
            </TabsContent>
          ))}
        </Tabs>
      )}
    </div>
  );
}

export default App;

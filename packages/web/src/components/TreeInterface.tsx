import React, { useState, useCallback } from "react";
import { WasmProllyTreeCursor } from "prolly-wasm";
import { type TreeState, useAppStore } from "@/useAppStore";
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "./ui/card";
import { Button } from "./ui/button";
import { Input } from "./ui/input";
import { Textarea } from "./ui/textarea";
import { ScrollArea } from "./ui/scroll-area";
import { Alert, AlertDescription, AlertTitle } from "./ui/alert";
import {
  Loader2,
  CheckCircle,
  XCircle,
  FileDown,
  RefreshCw,
  Trash2,
  List,
  Search,
  GitCompareArrows,
  Eraser,
} from "lucide-react";
import {
  FILE_SIGNATURE,
  FILE_VERSION,
  TAG_METADATA,
  TAG_CHUNK,
  toU8,
  u8ToString,
  u8ToHex,
  hexToU8,
  generateTreeFilename,
  triggerBrowserDownload,
} from "@/lib/prollyUtils"; // Import from the new utility file

// Define operation types for loading states
type TreeOperation =
  | "insert"
  | "get"
  | "delete"
  | "list"
  | "exportChunks"
  | "diff"
  | "gc"
  | "save"
  | "refreshHash";

interface TreeInterfaceProps {
  treeState: TreeState;
}

export function TreeInterface({ treeState }: TreeInterfaceProps) {
  const { updateTreeState } = useAppStore();

  // Local state for inputs
  const [insertKey, setInsertKey] = useState("");
  const [insertValue, setInsertValue] = useState("");
  const [getKey, setGetKey] = useState("");
  const [deleteKey, setDeleteKey] = useState("");
  const [diffHash1, setDiffHash1] = useState("");
  const [diffHash2, setDiffHash2] = useState("");
  const [gcLiveHashes, setGcLiveHashes] = useState("");

  // Loading and feedback state
  const [loadingStates, setLoadingStates] = useState<
    Record<TreeOperation, boolean>
  >({
    insert: false,
    get: false,
    delete: false,
    list: false,
    exportChunks: false,
    diff: false,
    gc: false,
    save: false,
    refreshHash: false,
  });
  const [feedback, setFeedback] = useState<{
    type: "success" | "error";
    message: string;
  } | null>(null);

  /**
   * Sets loading state for a specific operation.
   */
  const setLoading = (op: TreeOperation, isLoading: boolean) => {
    setLoadingStates((prev) => ({ ...prev, [op]: isLoading }));
  };

  /**
   * Updates the tree state in the global store and sets UI feedback.
   */
  const updateStateAndFeedback = useCallback(
    (
      updates: Partial<Omit<TreeState, "id" | "tree">>,
      feedbackMsg?: { type: "success" | "error"; message: string }
    ) => {
      updateTreeState(treeState.id, updates);
      if (feedbackMsg) {
        setFeedback(feedbackMsg);
      } else if (updates.lastError) {
        setFeedback({ type: "error", message: updates.lastError });
      } else if (updates.lastValue) {
        setFeedback({ type: "success", message: updates.lastValue });
      } else {
        setFeedback(null);
      }
    },
    [treeState.id, updateTreeState]
  );

  /**
   * Refreshes the root hash displayed in the UI.
   */
  const refreshRootHash = useCallback(
    async (showFeedback = false) => {
      setLoading("refreshHash", true);
      setFeedback(null);
      try {
        const rh = await treeState.tree.getRootHash();
        const newRootHash = u8ToHex(rh);
        updateStateAndFeedback(
          {
            rootHash: newRootHash,
            lastError: null,
            lastValue: showFeedback
              ? "Root hash refreshed."
              : treeState.lastValue,
          },
          showFeedback
            ? { type: "success", message: "Root hash refreshed." }
            : undefined
        );
      } catch (e: any) {
        updateStateAndFeedback({ lastError: e.message });
      } finally {
        setLoading("refreshHash", false);
      }
    },
    [treeState.tree, updateStateAndFeedback, treeState.lastValue]
  );

  const handleOperation = async (
    opType: TreeOperation,
    action: () => Promise<
      Partial<Omit<TreeState, "id" | "tree">> | { message: string } | void
    >
  ) => {
    setLoading(opType, true);
    setFeedback(null);
    try {
      const result = await action();
      if (result && "message" in result) {
        // Custom success message from action
        setFeedback({ type: "success", message: result.message });
      } else if (result) {
        // Updates to store
        updateStateAndFeedback(
          result as Partial<Omit<TreeState, "id" | "tree">>
        );
      }
      // Some operations might implicitly update global state via their own updateStateAndFeedback calls
    } catch (e: any) {
      console.error(`${opType} error:`, e);
      updateStateAndFeedback({ lastError: e.message });
    } finally {
      setLoading(opType, false);
    }
  };

  const handleInsert = () =>
    handleOperation("insert", async () => {
      if (!insertKey) throw new Error("Insert key cannot be empty.");
      await treeState.tree.insert(toU8(insertKey), toU8(insertValue));
      await refreshRootHash();
      setInsertKey("");
      setInsertValue("");
      return { lastValue: "Insert successful.", lastError: null };
    });

  const handleGet = () =>
    handleOperation("get", async () => {
      if (!getKey) throw new Error("Get key cannot be empty.");
      const value = await treeState.tree.get(toU8(getKey));
      return {
        lastValue: value ? u8ToString(value) : "null (not found)",
        lastError: null,
      };
    });

  const handleDelete = () =>
    handleOperation("delete", async () => {
      if (!deleteKey) throw new Error("Delete key cannot be empty.");
      const deleted = await treeState.tree.delete(toU8(deleteKey));
      await refreshRootHash();
      setDeleteKey("");
      return {
        lastValue: deleted
          ? "Delete successful"
          : "Delete failed (key not found)",
        lastError: null,
      };
    });

  const handleListItems = () =>
    handleOperation("list", async () => {
      const fetchedItems: { key: string; value: string }[] = [];
      const cursor: WasmProllyTreeCursor = await treeState.tree.cursorStart();
      while (true) {
        const result = await cursor.next();
        if (result.done) break;
        if (result.value) {
          const [keyU8, valueU8] = result.value;
          fetchedItems.push({
            key: u8ToString(keyU8),
            value: u8ToString(valueU8),
          });
        }
      }
      return {
        items: fetchedItems,
        lastError: null,
        lastValue: `Listed ${fetchedItems.length} items.`,
      };
    });

  const handleExportChunks = () =>
    handleOperation("exportChunks", async () => {
      const chunkMap = await treeState.tree.exportChunks();
      const exportedChunks: { hash: string; size: number }[] = [];
      chunkMap.forEach((value: Uint8Array, key: Uint8Array) => {
        exportedChunks.push({ hash: u8ToHex(key), size: value.length });
      });
      return {
        chunks: exportedChunks,
        lastError: null,
        lastValue: `Exported ${exportedChunks.length} chunks.`,
      };
    });

  const handleDiff = () =>
    handleOperation("diff", async () => {
      const h1 = hexToU8(diffHash1);
      const h2 = hexToU8(diffHash2);
      const diffEntries = await treeState.tree.diffRoots(h1, h2);
      const formattedDiffs = diffEntries.map((entry: any) => ({
        // `any` due to Wasm return type flexibility
        key: u8ToString(entry.key),
        left: entry.leftValue ? u8ToString(entry.leftValue) : undefined,
        right: entry.rightValue ? u8ToString(entry.rightValue) : undefined,
      }));
      return {
        diffResult: formattedDiffs,
        lastError: null,
        lastValue: `Diff computed with ${formattedDiffs.length} differences.`,
      };
    });

  const handleGc = () =>
    handleOperation("gc", async () => {
      const liveHashesU8Arrays = gcLiveHashes
        .split(",")
        .map((h) => h.trim())
        .map((h) => hexToU8(h))
        .filter((arr) => arr !== null) as Uint8Array[];
      const collectedCount = await treeState.tree.triggerGc(liveHashesU8Arrays);
      await handleExportChunks(); // Refresh chunk list
      return {
        gcCollectedCount: collectedCount,
        lastError: null,
        lastValue: `${collectedCount} chunk(s) collected by GC.`,
      };
    });

  const handleSaveTree = () =>
    handleOperation("save", async () => {
      const rootHashU8 = await treeState.tree.getRootHash();
      const treeConfigJsValue = await treeState.tree.getTreeConfig(); // This is a JsValue
      const treeConfig = treeConfigJsValue.into_serde(); // Convert JsValue to JS object

      const chunksMap = await treeState.tree.exportChunks();
      const chunkCount = chunksMap.size;

      const metadata = {
        rootHash: rootHashU8 ? u8ToHex(rootHashU8) : null,
        treeConfig: treeConfig,
        createdAt: new Date().toISOString(),
        chunkCount: chunkCount,
      };
      const metadataJsonString = JSON.stringify(metadata);
      const metadataBytes = toU8(metadataJsonString);

      let totalSize = FILE_SIGNATURE.length + 1 + 1 + 4 + metadataBytes.length;
      const chunksArray: { hash: Uint8Array; data: Uint8Array }[] = [];
      chunksMap.forEach((data, hash) => {
        chunksArray.push({ hash, data });
        totalSize += 1 + 4 + 32 + data.length;
      });

      const buffer = new ArrayBuffer(totalSize);
      const view = new DataView(buffer);
      let offset = 0;

      toU8(FILE_SIGNATURE).forEach((byte, i) =>
        view.setUint8(offset + i, byte)
      );
      offset += FILE_SIGNATURE.length;
      view.setUint8(offset, FILE_VERSION);
      offset += 1;
      view.setUint8(offset, TAG_METADATA);
      offset += 1;
      view.setUint32(offset, metadataBytes.length, true);
      offset += 4;
      new Uint8Array(buffer, offset, metadataBytes.length).set(metadataBytes);
      offset += metadataBytes.length;

      for (const chunk of chunksArray) {
        view.setUint8(offset, TAG_CHUNK);
        offset += 1;
        view.setUint32(offset, 32 + chunk.data.length, true);
        offset += 4;
        new Uint8Array(buffer, offset, 32).set(chunk.hash);
        offset += 32;
        new Uint8Array(buffer, offset, chunk.data.length).set(chunk.data);
        offset += chunk.data.length;
      }

      triggerBrowserDownload(buffer, generateTreeFilename(treeState.id));
      return { message: "Tree save initiated." };
    });

  const OperationFeedback = () => {
    if (!feedback) return null;
    const Icon = feedback.type === "success" ? CheckCircle : XCircle;
    const alertVariant =
      feedback.type === "success" ? "default" : "destructive";

    return (
      <Alert variant={alertVariant} className="my-4">
        <Icon className="h-4 w-4" />
        <AlertTitle>
          {feedback.type === "success" ? "Success" : "Error"}
        </AlertTitle>
        <AlertDescription>{feedback.message}</AlertDescription>
      </Alert>
    );
  };

  const renderOpButton = (
    opType: TreeOperation,
    onClick: () => void,
    label: string,
    icon?: React.ReactNode,
    disabled?: boolean,
    variant?:
      | "default"
      | "destructive"
      | "outline"
      | "secondary"
      | "ghost"
      | "link"
      | null
      | undefined
  ) => {
    return (
      <Button
        onClick={onClick}
        disabled={loadingStates[opType] || disabled}
        variant={variant || "default"}
      >
        {loadingStates[opType] ? (
          <Loader2 className="mr-2 h-4 w-4 animate-spin" />
        ) : (
          icon && <span className="mr-2 h-4 w-4">{icon}</span>
        )}
        {label}
      </Button>
    );
  };

  return (
    <Card className="w-full shadow-lg">
      <CardHeader>
        <CardTitle className="text-xl">Tree: {treeState.id}</CardTitle>
        <CardDescription>
          Root Hash: {treeState.rootHash || "N/A (Empty Tree)"}
          {treeState.treeConfig && (
            <span className="block text-xs text-muted-foreground mt-1">
              (CFg: {treeState.treeConfig.targetFanout}/
              {treeState.treeConfig.minFanout} fanout,
              {treeState.treeConfig.maxInlineValueSize}B inline, CDC{" "}
              {treeState.treeConfig.cdcMinSize}-
              {treeState.treeConfig.cdcAvgSize}-
              {treeState.treeConfig.cdcMaxSize}B)
            </span>
          )}
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-6">
        <OperationFeedback />

        {/* === Basic Operations === */}
        <details className="space-y-3 group" open>
          <summary className="text-lg font-semibold cursor-pointer group-open:mb-2">
            Basic Operations
          </summary>
          <div className="pl-4 border-l-2 border-border space-y-4">
            {/* Insert */}
            <div className="space-y-2">
              <h4 className="font-medium">Insert / Update</h4>
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
                {renderOpButton(
                  "insert",
                  handleInsert,
                  "Insert",
                  <CheckCircle />,
                  !insertKey
                )}
              </div>
            </div>
            {/* Get */}
            <div className="space-y-2">
              <h4 className="font-medium">Get Value</h4>
              <div className="flex gap-2">
                <Input
                  placeholder="Key"
                  value={getKey}
                  onChange={(e) => setGetKey(e.target.value)}
                  disabled={loadingStates.get}
                />
                {renderOpButton("get", handleGet, "Get", <Search />, !getKey)}
              </div>
            </div>
            {/* Delete */}
            <div className="space-y-2">
              <h4 className="font-medium">Delete Key</h4>
              <div className="flex gap-2">
                <Input
                  placeholder="Key"
                  value={deleteKey}
                  onChange={(e) => setDeleteKey(e.target.value)}
                  disabled={loadingStates.delete}
                />
                {renderOpButton(
                  "delete",
                  handleDelete,
                  "Delete",
                  <Trash2 />,
                  !deleteKey,
                  "destructive"
                )}
              </div>
            </div>
          </div>
        </details>

        {/* === Data & Chunks === */}
        <details className="space-y-3 group">
          <summary className="text-lg font-semibold cursor-pointer group-open:mb-2">
            Data & Chunks
          </summary>
          <div className="pl-4 border-l-2 border-border space-y-4">
            {/* List Items */}
            <div className="space-y-2">
              <h4 className="font-medium">
                All Items ({treeState.items.length})
              </h4>
              {renderOpButton("list", handleListItems, "List Items", <List />)}
              {treeState.items.length > 0 && (
                <ScrollArea className="h-40 max-h-60 w-full rounded-md border p-2 mt-2 bg-secondary/30">
                  <pre className="text-xs text-left whitespace-pre-wrap break-all">
                    {treeState.items
                      .map(
                        (item) =>
                          `Key: ${item.key}\nValue: ${item.value}\n──────────────────`
                      )
                      .join("\n")}
                  </pre>
                </ScrollArea>
              )}
            </div>
            {/* Export Chunks */}
            <div className="space-y-2">
              <h4 className="font-medium">
                Stored Chunks ({treeState.chunks.length})
              </h4>
              {renderOpButton(
                "exportChunks",
                handleExportChunks,
                "Show Chunks"
              )}
              {treeState.chunks.length > 0 && (
                <ScrollArea className="h-40 max-h-60 w-full rounded-md border p-2 mt-2 bg-secondary/30">
                  <pre className="text-xs text-left">
                    {treeState.chunks
                      .map(
                        (chunk) => `Hash: ${chunk.hash} (Size: ${chunk.size} B)`
                      )
                      .join("\n")}
                  </pre>
                </ScrollArea>
              )}
            </div>
          </div>
        </details>

        {/* === Advanced Operations === */}
        <details className="space-y-3 group">
          <summary className="text-lg font-semibold cursor-pointer group-open:mb-2">
            Advanced Operations
          </summary>
          <div className="pl-4 border-l-2 border-border space-y-4">
            {/* Diff Trees */}
            <div className="space-y-2">
              <h4 className="font-medium">
                Diff Trees (using this tree's store)
              </h4>
              <div className="flex flex-col gap-2">
                <Input
                  placeholder="Root Hash 1 (hex, optional)"
                  value={diffHash1}
                  onChange={(e) => setDiffHash1(e.target.value)}
                  disabled={loadingStates.diff}
                />
                <Input
                  placeholder="Root Hash 2 (hex, optional)"
                  value={diffHash2}
                  onChange={(e) => setDiffHash2(e.target.value)}
                  disabled={loadingStates.diff}
                />
                {renderOpButton(
                  "diff",
                  handleDiff,
                  "Diff",
                  <GitCompareArrows />
                )}
              </div>
              {treeState.diffResult.length > 0 && (
                <ScrollArea className="h-40 max-h-60 w-full rounded-md border p-2 mt-2 bg-secondary/30">
                  <pre className="text-xs text-left whitespace-pre-wrap break-all">
                    {treeState.diffResult
                      .map(
                        (d) =>
                          `Key: ${d.key}\n  Left: ${
                            d.left ?? "N/A"
                          }\n  Right: ${d.right ?? "N/A"}\n──────────────────`
                      )
                      .join("\n")}
                  </pre>
                </ScrollArea>
              )}
            </div>
            {/* Garbage Collection */}
            <div className="space-y-2">
              <h4 className="font-medium">Garbage Collection</h4>
              <Textarea
                placeholder="Live Root Hashes (comma-separated hex strings)"
                value={gcLiveHashes}
                onChange={(e) => setGcLiveHashes(e.target.value)}
                rows={2}
                disabled={loadingStates.gc}
              />
              {renderOpButton("gc", handleGc, "Trigger GC", <Eraser />)}
              {treeState.gcCollectedCount !== null && (
                <p className="text-sm mt-1">
                  Chunks collected: {treeState.gcCollectedCount}
                </p>
              )}
            </div>
          </div>
        </details>
      </CardContent>
      <CardFooter className="flex-col items-start gap-2 sm:flex-row sm:justify-between">
        {renderOpButton(
          "refreshHash",
          () => refreshRootHash(true),
          "Refresh Root Hash",
          <RefreshCw />,
          false,
          "outline"
        )}
        {renderOpButton(
          "save",
          handleSaveTree,
          "Save Tree to File",
          <FileDown />
        )}
      </CardFooter>
    </Card>
  );
}

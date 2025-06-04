// In packages/web/src/components/treeOperations/VirtualizedHierarchyScan.tsx

import React, { useEffect, useRef, useState, useMemo } from "react";
import { useInfiniteQuery, type InfiniteData } from "@tanstack/react-query";
import { useVirtualizer } from "@tanstack/react-virtual";
import {
  type WasmProllyTree,
  type WasmHierarchyItem,
  type HierarchyScanOptions as HierarchyScanArgsWasm,
} from "prolly-wasm";
import { u8ToString, toU8 } from "@/lib/prollyUtils"; //
import u8ToHex from "@/utils/u8ToHex"; //

import {
  Loader2,
  XCircle,
  Search,
  Network,
  ArrowDownWideNarrow,
  KeyRound,
} from "lucide-react";
import { toast } from "sonner";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";

import { useDebounce } from "use-debounce";

type HierarchyQuery_QueryKey = readonly [
  string,
  string | null,
  Omit<HierarchyScanArgsWasm, "limit" | "offset">
];

interface DisplayHierarchyItem {
  id: string;
  type: WasmHierarchyItem["type"];
  data: WasmHierarchyItem;
  formatted: Partial<Record<string, string | undefined>>; // Adjusted for u8ToHex potentially returning undefined/string
  level?: number;
}

interface HierarchyScanPageResult {
  items: WasmHierarchyItem[];
  hasNextPage: boolean;
  nextPageCursorToken?: string | null;
}

interface VirtualizedHierarchyScanProps {
  tree: WasmProllyTree | null;
  treePath: string;
  currentRoot: string | null;
  height?: string;
  itemHeight?: number;
}

const processHierarchyItem = (
  item: WasmHierarchyItem,
  index: number
): DisplayHierarchyItem => {
  const formatted: DisplayHierarchyItem["formatted"] = {};
  let idBase = `${item.type}-${index}`; // Simple initial ID
  let displayLevel = 0;

  // Helper to apply u8ToHex safely
  const formatHash = (hash?: Uint8Array): string | undefined =>
    hash ? u8ToHex(hash) : undefined;

  switch (item.type) {
    case "Node":
      formatted.hash = formatHash(item.hash);
      idBase = `node-${formatted.hash || index}`;
      displayLevel = item.pathIndices.length;
      break;
    case "InternalEntry":
      formatted.parentHash = formatHash(item.parentHash);
      formatted.boundaryKey = item.boundaryKey
        ? u8ToString(item.boundaryKey)
        : undefined;
      formatted.childHash = formatHash(item.childHash);
      idBase = `internal-${formatted.parentHash || index}-${item.entryIndex}`;
      // displayLevel could be set if we trace back to parent node's level
      break;
    case "LeafEntry":
      formatted.parentHash = formatHash(item.parentHash);
      formatted.key = item.key ? u8ToString(item.key) : undefined;
      if (item.valueHash) formatted.valueHash = formatHash(item.valueHash);
      idBase = `leaf-${formatted.parentHash || index}-${item.entryIndex}`;
      // displayLevel could be set similarly
      break;
  }

  return {
    id: idBase,
    type: item.type,
    data: item,
    formatted,
    level: displayLevel,
  };
};

const ITEMS_PER_PAGE = 30;

export const VirtualizedHierarchyScan: React.FC<
  VirtualizedHierarchyScanProps
> = ({ tree, treePath, currentRoot, height = "500px", itemHeight = 30 }) => {
  const [startKeyInput, setStartKeyInput] = useState<string>("");
  const [maxDepthInput, setMaxDepthInput] = useState<string>("");

  const [debouncedStartKeyInput] = useDebounce(startKeyInput, 500);
  const [debouncedMaxDepthInput] = useDebounce(maxDepthInput, 500);

  // appliedScanArgsForQueryKey will not include offset and limit, as these are handled by useInfiniteQuery
  const appliedScanArgsForQueryKey = useMemo<
    Omit<HierarchyScanArgsWasm, "limit" | "offset">
  >(() => {
    const args: Omit<HierarchyScanArgsWasm, "limit" | "offset"> = {};
    if (debouncedStartKeyInput.trim()) {
      args.startKey = toU8(debouncedStartKeyInput.trim());
    }
    const depth = parseInt(debouncedMaxDepthInput, 10);
    if (!isNaN(depth) && depth >= 0) {
      args.maxDepth = depth;
    }
    return args;
  }, [debouncedStartKeyInput, debouncedMaxDepthInput]);

  const parentRef = useRef<HTMLDivElement>(null);

  const {
    data: infiniteQueryData,
    fetchNextPage,
    hasNextPage: RqHasNextPage,
    isFetchingNextPage,
    isLoading: isLoadingItems,
    isError: isItemsError,
    error: itemsError,
  } = useInfiniteQuery<
    HierarchyScanPageResult,
    Error,
    InfiniteData<HierarchyScanPageResult, number>, // TData
    HierarchyQuery_QueryKey, // TQueryKey
    number // TPageParam (this will be our offset)
  >({
    // Query key changes when base scan args (startKey, maxDepth) change
    queryKey: ["hierarchyScan", currentRoot, appliedScanArgsForQueryKey],
    queryFn: async ({ pageParam = 0 }) => {
      if (!tree) throw new Error("Tree not available for hierarchy scan.");

      const scanArgsForWasm: HierarchyScanArgsWasm = {
        ...appliedScanArgsForQueryKey, // startKey, maxDepth
        offset: pageParam, // +++ Use pageParam as offset +++
        limit: ITEMS_PER_PAGE,
      };
      return tree.hierarchyScan(scanArgsForWasm);
    },
    initialPageParam: 0, // Start with offset 0
    getNextPageParam: (lastPage, allPages, lastPageParam) => {
      if (lastPage.hasNextPage) {
        // Calculate the next offset: current offset + number of items fetched in the last page
        const newOffset = lastPageParam + (lastPage.items?.length || 0);
        // console.log(`getNextPageParam: lastPage had ${lastPage.items?.length} items, next offset: ${newOffset}`);
        return newOffset;
      }
      // console.log("getNextPageParam: No next page or no items in last page.");
      return undefined;
    },
    enabled: !!tree && currentRoot !== null,
  });

  const allFetchedRawItems = useMemo(() => {
    return infiniteQueryData?.pages.flatMap((page) => page.items) ?? [];
  }, [infiniteQueryData]);

  const allDisplayItems = useMemo(() => {
    return allFetchedRawItems.map((item, index) =>
      processHierarchyItem(item, index)
    );
  }, [allFetchedRawItems]);

  const estimatedTotalCount = RqHasNextPage
    ? allDisplayItems.length + ITEMS_PER_PAGE
    : allDisplayItems.length;

  const rowVirtualizer = useVirtualizer({
    count: estimatedTotalCount,
    getScrollElement: () => parentRef.current,
    estimateSize: () => itemHeight,
    overscan: 10,
  });

  const virtualItems = rowVirtualizer.getVirtualItems();

  useEffect(() => {
    if (virtualItems.length === 0 || !RqHasNextPage || isFetchingNextPage) {
      return;
    }
    const lastItem = virtualItems[virtualItems.length - 1];
    // Check if the last visible item is close to the end of the currently loaded data
    // and if there's a next page indicated by React Query.
    if (
      lastItem &&
      lastItem.index >= allDisplayItems.length - 1 &&
      RqHasNextPage
    ) {
      fetchNextPage();
    }
  }, [
    virtualItems,
    RqHasNextPage,
    isFetchingNextPage,
    fetchNextPage,
    allDisplayItems.length,
  ]);

  const handleClearFilters = () => {
    setStartKeyInput("");
    setMaxDepthInput("");
    if (parentRef.current) parentRef.current.scrollTop = 0;
    rowVirtualizer.scrollToOffset(0);
    toast.info("Hierarchy scan filters cleared.");
  };

  const renderItemContent = (item: DisplayHierarchyItem) => {
    const indentStyle = {
      paddingLeft: `${
        (item.level || 0) * 18 + (item.type !== "Node" ? 18 : 0)
      }px`,
    };
    const commonTextClass = "text-xs text-muted-foreground truncate";
    const dataPillClass = "px-1.5 py-0.5 bg-muted rounded text-xs";

    switch (item.type) {
      case "Node":
        return (
          <div style={indentStyle} className="flex items-center gap-2 w-full">
            <Network
              size={14}
              className={item.data.isLeaf ? "text-green-600" : "text-blue-600"}
            />
            <span
              className={`font-medium text-xs ${
                item.data.isLeaf ? "text-green-700" : "text-blue-700"
              }`}
            >
              {item.data.isLeaf ? "LEAF" : "INTERNAL"}
            </span>
            <span className={commonTextClass}>(L{item.data.level})</span>
            <span
              className={`${commonTextClass} font-mono`}
              title={item.formatted.hash || "N/A"}
            >
              H: {item.formatted.hash?.substring(0, 12) || "N/A"}...
            </span>
            <span className={dataPillClass}>
              Entries: {item.data.numEntries}
            </span>
          </div>
        );
      case "InternalEntry":
        return (
          <div style={indentStyle} className="flex items-center gap-2 w-full">
            <span className="text-orange-600 text-xs">
              ↳ Entry #{item.data.entryIndex}
            </span>
            <span
              className={`${commonTextClass} font-mono`}
              title={item.formatted.boundaryKey || "N/A"}
            >
              BKey: {item.formatted.boundaryKey}
            </span>
            <span
              className={`${commonTextClass} font-mono`}
              title={item.formatted.childHash || "N/A"}
            >
              Child: {item.formatted.childHash?.substring(0, 12) || "N/A"}...
            </span>
            <span className={dataPillClass}>
              Subtree: {item.data.numItemsSubtree}
            </span>
          </div>
        );
      case "LeafEntry":
        return (
          <div style={indentStyle} className="flex items-center gap-2 w-full">
            <span className="text-purple-600 text-xs">
              ↳ Entry #{item.data.entryIndex}
            </span>
            <span
              className={`${commonTextClass} font-mono`}
              title={item.formatted.key || "N/A"}
            >
              Key: {item.formatted.key}
            </span>
            <span className={dataPillClass}>{item.data.valueReprType}</span>
            {item.data.valueHash && (
              <span
                className={`${commonTextClass} font-mono`}
                title={item.formatted.valueHash || "N/A"}
              >
                VHash: {item.formatted.valueHash?.substring(0, 12) || "N/A"}...
              </span>
            )}
            <span className={dataPillClass}>VSize: {item.data.valueSize}</span>
          </div>
        );
      default:
        // This case should ideally not be reached if WasmHierarchyItem is a tagged union
        const unknownItem = item as any;
        return (
          <div style={indentStyle} className="text-xs">
            Unknown item type: {unknownItem.type}
          </div>
        );
    }
  };

  const renderMainContent = () => {
    if (isLoadingItems && !infiniteQueryData?.pages.length) {
      // Show loading only if no pages are loaded yet
      return (
        <div
          className="flex flex-col items-center justify-center p-4"
          style={{ height }}
        >
          <Loader2 className="h-8 w-8 animate-spin text-primary mb-2" />
          <p className="text-sm text-muted-foreground">Scanning hierarchy...</p>
        </div>
      );
    }

    if (isItemsError) {
      return (
        <div
          className="flex flex-col items-center justify-center p-4 text-destructive"
          style={{ height }}
        >
          <XCircle className="h-8 w-8 mb-2" />
          <p className="text-sm font-semibold">Error scanning hierarchy</p>
          <p className="text-xs">
            {itemsError?.message || "An unknown error occurred."}
          </p>
        </div>
      );
    }

    if (
      allDisplayItems.length === 0 &&
      !isFetchingNextPage &&
      !isLoadingItems
    ) {
      const noItemsMessage =
        appliedScanArgsForQueryKey.startKey ||
        appliedScanArgsForQueryKey.maxDepth !== undefined ? (
          <>
            <Search className="h-12 w-12 text-muted-foreground/50 mb-3" />
            <p className="text-muted-foreground text-sm">
              No hierarchy items match the current filters.
            </p>
          </>
        ) : (
          <>
            <Network className="h-12 w-12 text-muted-foreground/50 mb-3" />
            <p className="text-muted-foreground text-sm">
              Hierarchy is empty or not available.
            </p>
          </>
        );
      return (
        <div
          className="flex flex-col items-center justify-center p-4 text-center"
          style={{ height }}
        >
          {noItemsMessage}
        </div>
      );
    }

    return (
      <>
        <div
          ref={parentRef}
          style={{
            height,
            overflowY: "auto",
            border: "1px solid hsl(var(--border))",
            borderRadius: "var(--radius)",
          }}
          className="bg-muted/20 dark:bg-muted/10 relative"
        >
          {isFetchingNextPage && ( // Show loading indicator only for next page fetching
            <div className="sticky top-2 left-1/2 -translate-x-1/2 z-10 bg-background/80 backdrop-blur-sm p-2 rounded-md shadow-lg text-xs flex items-center">
              <Loader2 className="h-4 w-4 animate-spin inline-block mr-1" />
              Loading more...
            </div>
          )}
          <div
            style={{
              height: `${rowVirtualizer.getTotalSize()}px`,
              width: "100%",
              position: "relative",
            }}
          >
            {virtualItems.map((virtualRow) => {
              const item = allDisplayItems[virtualRow.index];
              return (
                <div
                  key={item ? item.id : virtualRow.key}
                  data-index={virtualRow.index}
                  ref={rowVirtualizer.measureElement}
                  style={{
                    position: "absolute",
                    top: 0,
                    left: 0,
                    width: "100%",
                    height: `${virtualRow.size}px`,
                    transform: `translateY(${virtualRow.start}px)`,
                    padding: "5px 12px",
                    display: "flex",
                    alignItems: "center",
                    borderBottom: "1px solid hsl(var(--border)/0.3)",
                  }}
                  className={
                    virtualRow.index % 2 === 0
                      ? "bg-transparent hover:bg-muted/20"
                      : "bg-muted/10 dark:bg-black/10 hover:bg-muted/30"
                  }
                >
                  {item ? (
                    renderItemContent(item)
                  ) : (
                    <div className="w-full text-center text-xs">
                      Loading row...
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </div>
        <div className="text-right text-xs text-muted-foreground pt-1 pr-1">
          Displaying {allDisplayItems.length.toLocaleString()} items
          {RqHasNextPage && " (more available)"}
        </div>
      </>
    );
  };

  return (
    <div className="flex flex-col space-y-3">
      <div className="p-4 border bg-card rounded-lg shadow-sm space-y-4">
        <div className="flex items-center justify-between mb-2">
          <h3 className="text-md font-semibold">Hierarchy Scan Parameters</h3>
        </div>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4 items-end">
          <div>
            <Label htmlFor="h_startKey" className="text-xs font-medium">
              <KeyRound className="inline-block mr-1 h-3 w-3" />
              Start Key (optional)
            </Label>
            <Input
              id="h_startKey"
              type="text"
              placeholder="Scan from key (UTF-8)"
              value={startKeyInput}
              onChange={(e) => setStartKeyInput(e.target.value)}
              className="h-9 text-sm"
              title="If provided, the scan will attempt to start near this key's path."
            />
          </div>
          <div>
            <Label htmlFor="h_maxDepth" className="text-xs font-medium">
              <ArrowDownWideNarrow className="inline-block mr-1 h-3 w-3" />
              Max Depth (optional)
            </Label>
            <Input
              id="h_maxDepth"
              type="number"
              placeholder="e.g., 0, 1, 2..."
              value={maxDepthInput}
              onChange={(e) => setMaxDepthInput(e.target.value)}
              min="0"
              className="h-9 text-sm"
              title="0 for root, 1 for root and direct children, etc. Blank for no limit."
            />
          </div>
        </div>
        <div className="flex items-center gap-2 pt-2 justify-end">
          <Button
            onClick={handleClearFilters}
            size="sm"
            variant="outline"
            className="h-9"
            disabled={isLoadingItems || isFetchingNextPage}
          >
            <XCircle className="mr-2 h-4 w-4" /> Clear & Reset
          </Button>
        </div>
      </div>
      {renderMainContent()}
    </div>
  );
};

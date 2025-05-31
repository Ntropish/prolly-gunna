import React, { useEffect, useRef, useState, useMemo } from "react";
import {
  // QueryClient, // Not needed directly in this component
  // QueryClientProvider, // Setup in App.tsx
  useQuery,
  useInfiniteQuery,
  type InfiniteData, // Import InfiniteData
} from "@tanstack/react-query";
import { useVirtualizer } from "@tanstack/react-virtual";
import { type WasmProllyTree } from "prolly-wasm";
import { u8ToString, toU8 } from "@/lib/prollyUtils";
import {
  Loader2,
  XCircle,
  Search,
  ArrowRightToLine,
  MoveHorizontal,
} from "lucide-react";
import { toast } from "sonner";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Checkbox } from "@/components/ui/checkbox";
import { useDownloadScanAsJsonlMutation } from "@/hooks/useTreeMutations";
import type { ScanArgsWasm } from "@/lib/types";
import { Download } from "lucide-react";

import { useDebounce } from "use-debounce";
import { getPrefixScanEndBound } from "@/lib/utils/getPrefixScanEndBound";
import { Tabs, TabsList, TabsTrigger } from "@radix-ui/react-tabs";

// --- Interfaces ---
interface Item {
  key: string;
  value: string;
}

interface ScanArgs {
  startBound?: Uint8Array | null;
  endBound?: Uint8Array | null;
  startInclusive?: boolean;
  endInclusive?: boolean;
  reverse?: boolean;
  offset?: number;
  limit?: number;
}

interface ScanPage {
  items: [Uint8Array, Uint8Array][];
  hasNextPage: boolean;
  hasPreviousPage: boolean;
  nextPageCursor?: Uint8Array | null;
  previousPageCursor?: Uint8Array | null;
}

interface VirtualizedTreeItemsProps {
  tree: WasmProllyTree | null;
  treeId: string;
  currentRoot: string | null;
  height?: string;
  itemHeight?: number;
}

// Type for the query key used by useInfiniteQuery and useQuery for items/counts
type ItemsQuery_QueryKey = readonly [
  string, // Base key, e.g., 'items' or 'filteredItemCount'
  string | null, // currentRoot
  Omit<ScanArgs, "offset" | "limit"> // appliedScanArgs
];

const processScanPageItems = (rawItems: [Uint8Array, Uint8Array][]): Item[] => {
  if (!rawItems) return [];
  return rawItems.map((pair) => ({
    key: u8ToString(pair[0]),
    value: u8ToString(pair[1]),
  }));
};

const ITEMS_PER_PAGE = 50;

// --- Main Component ---
export const VirtualizedTreeItems: React.FC<VirtualizedTreeItemsProps> = ({
  tree,
  treeId,
  currentRoot,
  height = "400px",
  itemHeight = 60,
}) => {
  const [scanMode, setScanMode] = useState<"range" | "prefix">("prefix");

  // --- Canonical Scan Parameters ---
  const [trueStartBound, setTrueStartBound] = useState<Uint8Array | null>(null);
  const [trueEndBound, setTrueEndBound] = useState<Uint8Array | null>(null);
  const [trueStartInclusive, setTrueStartInclusive] = useState<boolean>(true);
  const [trueEndInclusive, setTrueEndInclusive] = useState<boolean>(false);

  // --- Debounced Canonical Scan Parameters for React Query ---
  const [debouncedTrueStartBound] = useDebounce(trueStartBound, 500);
  const [debouncedTrueEndBound] = useDebounce(trueEndBound, 500);
  const [debouncedTrueStartInclusive] = useDebounce(trueStartInclusive, 500);
  const [debouncedTrueEndInclusive] = useDebounce(trueEndInclusive, 500);

  const appliedScanArgs = useMemo<Omit<ScanArgsWasm, "offset" | "limit">>(
    () => ({
      startBound: debouncedTrueStartBound ?? undefined,
      endBound: debouncedTrueEndBound ?? undefined,
      startInclusive: debouncedTrueStartInclusive,
      endInclusive: debouncedTrueEndInclusive,
    }),
    [
      debouncedTrueStartBound,
      debouncedTrueEndBound,
      debouncedTrueStartInclusive,
      debouncedTrueEndInclusive,
    ]
  );

  const parentRef = useRef<HTMLDivElement>(null);

  // --- Query for Unfiltered Total Item Count ---
  const { data: unfilteredTotalItems, isLoading: isLoadingUnfilteredCount } =
    useQuery<number, Error, number, readonly (string | null)[]>({
      queryKey: ["unfilteredTotalCount", currentRoot],
      queryFn: async () => {
        if (!tree) return 0;
        return tree.countAllItems() as Promise<number>;
      },
      enabled: !!tree,
      staleTime: Infinity,
    });

  // --- Query for Filtered Item Count ---
  const { data: filteredTotalItems, isLoading: isLoadingFilteredCount } =
    useQuery<number, Error, number, ItemsQuery_QueryKey>({
      queryKey: ["filteredItemCount", currentRoot, appliedScanArgs],
      queryFn: async () => {
        if (!tree) return 0;
        if (!appliedScanArgs.startBound && !appliedScanArgs.endBound) {
          return unfilteredTotalItems ?? 0;
        }
        let count = 0;
        let currentOffset = 0;
        const batchSizeForCount = 1000;
        // eslint-disable-next-line no-constant-condition
        while (true) {
          try {
            const page = await (tree.scanItems({
              ...appliedScanArgs,
              offset: currentOffset,
              limit: batchSizeForCount,
            }) as Promise<ScanPage>);
            count += page.items.length;
            if (!page.hasNextPage || page.items.length < batchSizeForCount) {
              break;
            }
            currentOffset += page.items.length;
          } catch (countError) {
            console.error("Error counting filtered items:", countError);
            toast.error("Could not determine filtered item count.");
            throw countError;
          }
        }
        return count;
      },
      enabled: !!tree && !isLoadingUnfilteredCount,
    });

  // --- Infinite Query for Fetching Items ---
  const {
    data: infiniteQueryData, // Type: InfiniteData<ScanPage, number> | undefined
    fetchNextPage,
    hasNextPage: RqHasNextPage,
    isFetchingNextPage,
    isLoading: isLoadingItems,
    isError: isItemsError,
    error: itemsError,
  } = useInfiniteQuery<
    ScanPage, // TQueryFnData
    Error, // TError
    InfiniteData<ScanPage, number>, // TData (explicitly what `data` will be)
    ItemsQuery_QueryKey, // TQueryKey
    number // TPageParam
  >({
    queryKey: ["tree", currentRoot, appliedScanArgs],
    queryFn: async ({ pageParam = 0 }) => {
      if (!tree) throw new Error("Tree not available for fetching items.");
      const scanArgsWithContext: ScanArgs = {
        ...appliedScanArgs,
        offset: pageParam,
        limit: ITEMS_PER_PAGE,
      };
      return tree.scanItems(scanArgsWithContext) as Promise<ScanPage>;
    },
    initialPageParam: 0,
    getNextPageParam: (lastPage, _allPages, lastPageParam) => {
      // lastPage is ScanPage, allPages is ScanPage[]
      if (lastPage.hasNextPage) {
        // Calculate next offset based on the last page param and items fetched in that page
        // This assumes lastPage.items.length is accurate for the limit requested
        return lastPageParam + lastPage.items.length;
      }
      return undefined;
    },
    enabled:
      !!tree && filteredTotalItems !== undefined && filteredTotalItems > 0,
  });

  console.log({
    tree,
    filteredTotalItems,
    unfilteredTotalItems,
    appliedScanArgs,
  });

  const allFetchedRawItems = useMemo(() => {
    return infiniteQueryData?.pages.flatMap((page) => page.items) ?? [];
  }, [infiniteQueryData]);

  const allDisplayItems = useMemo(() => {
    return processScanPageItems(allFetchedRawItems);
  }, [allFetchedRawItems]);

  const rowVirtualizer = useVirtualizer({
    count: filteredTotalItems ?? 0,
    getScrollElement: () => parentRef.current,
    estimateSize: () => itemHeight,
    overscan: 5,
  });

  const virtualItems = rowVirtualizer.getVirtualItems();

  useEffect(() => {
    if (virtualItems.length === 0 || !RqHasNextPage || isFetchingNextPage) {
      return;
    }
    const lastItem = virtualItems[virtualItems.length - 1];
    // Fetch when the last visible item is within half a page of the end of loaded data
    if (
      lastItem &&
      lastItem.index >= allDisplayItems.length - ITEMS_PER_PAGE / 2
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

  const downloadScanMutation = useDownloadScanAsJsonlMutation();

  const handleDownloadScan = () => {
    if (!tree) {
      toast.error("Tree instance not available for download.");
      return;
    }
    // appliedScanArgs is already Omit<ScanArgsWasm, "offset" | "limit">
    downloadScanMutation.mutate({ tree, treeId, scanArgs: appliedScanArgs });
  };

  const handleClearFilters = () => {
    setTrueStartBound(null);
    setTrueEndBound(null);
    setTrueStartInclusive(true); // Default for "scan all"
    setTrueEndInclusive(false); // Default for "scan all" (or true, depending on desired default)
    if (parentRef.current) parentRef.current.scrollTop = 0;
    rowVirtualizer.scrollToOffset(0);
    toast.info("Filters cleared.");
  };

  const handleScanModeChange = (newModeValue: string) => {
    const newMode = newModeValue as "range" | "prefix";
    const oldMode = scanMode; // Capture the mode before it's updated

    // Set the scanMode first, so UI can potentially react if needed,
    // though for this logic, oldMode is key.
    setScanMode(newMode);

    if (newMode === "prefix" && oldMode === "range") {
      // --- Transitioning from Range mode TO Prefix mode ---
      // The current 'trueStartBound' will become the prefix.
      // We must update the other canonical parameters to define a valid prefix scan
      // based on this trueStartBound.
      if (trueStartBound) {
        // If there's an existing start bound, use it as the prefix
        const prefixEndBound = getPrefixScanEndBound(trueStartBound);

        // Update canonical state for a prefix definition
        // No need to setTrueStartBound, it's already our prefix base
        setTrueStartInclusive(true);
        setTrueEndBound(prefixEndBound === undefined ? null : prefixEndBound);
        setTrueEndInclusive(false);
      } else {
        // If trueStartBound is null (e.g., filters were cleared, or range was like (null, "someEndKey")),
        // an empty/null prefix means "scan all".
        // This aligns with how handlePrefixInputChange treats an empty input.
        // setTrueStartBound(null); // Already null
        setTrueStartInclusive(true);
        setTrueEndBound(null);
        setTrueEndInclusive(false);
      }
    }
  };

  // --- Event Handlers for UI inputs to update Canonical State ---
  const handlePrefixInputChange = (value: string) => {
    const trimmedValue = value.trim();
    if (!trimmedValue) {
      // Empty prefix: scan all
      setTrueStartBound(null);
      setTrueStartInclusive(true);
      setTrueEndBound(null);
      setTrueEndInclusive(false);
    } else {
      const newPrefixU8 = toU8(trimmedValue);
      const calculatedEndBound = getPrefixScanEndBound(newPrefixU8); // Store in a variable

      setTrueStartBound(newPrefixU8);
      setTrueStartInclusive(true);
      // Correctly handle potential undefined from getPrefixScanEndBound
      setTrueEndBound(
        calculatedEndBound === undefined ? null : calculatedEndBound
      );
      setTrueEndInclusive(false);
    }
  };

  const handleRangeStartKeyChange = (value: string) => {
    setTrueStartBound(value.trim() ? toU8(value.trim()) : null);
  };
  const handleRangeEndKeyChange = (value: string) => {
    setTrueEndBound(value.trim() ? toU8(value.trim()) : null);
  };
  const handleRangeStartInclusiveChange = (checked: boolean) => {
    setTrueStartInclusive(checked);
  };
  const handleRangeEndInclusiveChange = (checked: boolean) => {
    setTrueEndInclusive(checked);
  };

  const renderContent = () => {
    if (
      isLoadingUnfilteredCount ||
      (isLoadingFilteredCount &&
        filteredTotalItems === undefined &&
        (appliedScanArgs.startBound || appliedScanArgs.endBound))
    ) {
      return (
        <div
          className="flex flex-col items-center justify-center p-4"
          style={{ height }}
        >
          <Loader2 className="h-8 w-8 animate-spin text-muted-foreground mb-2" />
          <p className="text-sm text-muted-foreground">
            Loading item counts...
          </p>
        </div>
      );
    }

    if (
      isLoadingItems &&
      allDisplayItems.length === 0 &&
      (filteredTotalItems ?? 0) > 0
    ) {
      return (
        <div
          className="flex flex-col items-center justify-center p-4"
          style={{ height }}
        >
          <Loader2 className="h-8 w-8 animate-spin text-primary mb-2" />
          <p className="text-sm text-muted-foreground">Fetching items...</p>
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
          <p className="text-sm font-semibold">Error loading items</p>
          <p className="text-xs">
            {itemsError?.message || "An unknown error occurred."}
          </p>
        </div>
      );
    }

    if (
      (filteredTotalItems ?? 0) === 0 &&
      (appliedScanArgs.startBound || appliedScanArgs.endBound)
    ) {
      return (
        <div
          className="flex flex-col items-center justify-center p-4 text-center"
          style={{ height }}
        >
          <Search className="h-12 w-12 text-muted-foreground/50 mb-3" />
          <p className="text-muted-foreground text-sm">
            No items match the current filters.
          </p>
          {unfilteredTotalItems !== undefined && (
            <p className="text-xs text-muted-foreground/80 mt-1">
              (Total items in tree: {unfilteredTotalItems.toLocaleString()})
            </p>
          )}
        </div>
      );
    }

    if (
      (filteredTotalItems ?? 0) === 0 &&
      !appliedScanArgs.startBound &&
      !appliedScanArgs.endBound
    ) {
      return (
        <div
          className="flex flex-col items-center justify-center p-4 text-center"
          style={{ height }}
        >
          <Search className="h-12 w-12 text-muted-foreground/50 mb-3" />
          <p className="text-muted-foreground text-sm">Tree is empty.</p>
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
            borderRadius: "var(--radius-md)",
          }}
          className="bg-muted/20 dark:bg-muted/10 relative"
        >
          {(isFetchingNextPage ||
            (isLoadingItems &&
              allDisplayItems.length === 0 &&
              (filteredTotalItems ?? 0) > 0)) && (
            <div className="sticky top-2 left-1/2 -translate-x-1/2 z-10 bg-background/80 backdrop-blur-sm p-2 rounded-md shadow-lg text-xs flex items-center">
              <Loader2 className="h-4 w-4 animate-spin inline-block mr-1" />
              Loading...
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
                  key={virtualRow.key} // Use virtualRow.key for React list key
                  data-index={virtualRow.index}
                  ref={rowVirtualizer.measureElement}
                  style={{
                    position: "absolute",
                    top: 0,
                    left: 0,
                    width: "100%",
                    height: `${virtualRow.size}px`,
                    transform: `translateY(${virtualRow.start}px)`,
                    padding: "10px 12px",
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
                    <div className="flex flex-col items-start gap-1 w-full">
                      <div
                        className="flex-1 text-right font-mono text-sm truncate text-muted-foreground"
                        title={item.key}
                      >
                        {item.key}
                      </div>
                      <div
                        // full width, text wrap
                        className="flex-1 text-left font-mono text-sm truncate w-full"
                        title={item.value}
                      >
                        {item.value}
                      </div>
                    </div>
                  ) : (
                    <div className="text-xs text-muted-foreground/70 w-full text-center h-full flex items-center justify-center">
                      {/* This row is virtualized but data not yet loaded by useInfiniteQuery */}
                      &nbsp;
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </div>
        <div className="text-right text-xs text-muted-foreground pt-1 pr-1">
          {(filteredTotalItems ?? 0).toLocaleString()}
          {unfilteredTotalItems !== undefined &&
            ` / ${unfilteredTotalItems.toLocaleString()}`}
        </div>
      </>
    );
  };

  return (
    <div className="flex flex-col space-y-3">
      <div className="p-4 border bg-card rounded-lg shadow-sm space-y-4">
        <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-3 mb-3">
          <h3 className="text-md font-semibold whitespace-nowrap">
            Scan Parameters
          </h3>
          <Tabs
            value={scanMode}
            onValueChange={handleScanModeChange} // Use the new handler
            className="w-full sm:w-auto"
          >
            <TabsList className="h-9">
              <TabsTrigger
                value="prefix"
                className="text-xs data-[state=active]:shadow-md"
              >
                <div className="flex items-center mr-3 px-3 py-2">
                  <ArrowRightToLine className="mr-1.5 h-4 w-4" />
                  Prefix
                </div>
              </TabsTrigger>

              <TabsTrigger
                value="range"
                className="text-xs data-[state=active]:shadow-md"
              >
                <div className="flex items-center mr-3 px-3 py-2">
                  <MoveHorizontal className="mr-1.5 h-4 w-4" />
                  Range
                </div>
              </TabsTrigger>
            </TabsList>
          </Tabs>
        </div>

        {scanMode === "range" && (
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4 items-start">
            <div className="flex flex-col space-y-1">
              <Label htmlFor="startKey" className="text-xs font-medium">
                Start Key
              </Label>
              <Input
                id="startKey"
                type="text"
                placeholder="Enter start key"
                value={trueStartBound ? u8ToString(trueStartBound) : ""}
                onChange={(e) => handleRangeStartKeyChange(e.target.value)}
                className="h-9 text-sm"
              />
              <div className="flex items-center space-x-2 pt-1">
                <Checkbox
                  id="startInclusive"
                  checked={trueStartInclusive}
                  onCheckedChange={(checked) =>
                    handleRangeStartInclusiveChange(!!checked)
                  }
                />
                <Label
                  htmlFor="startInclusive"
                  className="text-xs font-normal text-muted-foreground cursor-pointer"
                >
                  Inclusive
                </Label>
              </div>
            </div>
            <div className="flex flex-col space-y-1">
              <Label htmlFor="endKey" className="text-xs font-medium">
                End Key
              </Label>
              <Input
                id="endKey"
                type="text"
                placeholder="Enter end key"
                value={trueEndBound ? u8ToString(trueEndBound) : ""}
                onChange={(e) => handleRangeEndKeyChange(e.target.value)}
                className="h-9 text-sm"
              />
              <div className="flex items-center space-x-2 pt-1">
                <Checkbox
                  id="endInclusive"
                  checked={trueEndInclusive}
                  onCheckedChange={(checked) =>
                    handleRangeEndInclusiveChange(!!checked)
                  }
                />
                <Label
                  htmlFor="endInclusive"
                  className="text-xs font-normal text-muted-foreground cursor-pointer"
                >
                  Inclusive
                </Label>
              </div>
            </div>
          </div>
        )}

        {scanMode === "prefix" && (
          <div className="flex flex-col space-y-1">
            <Label htmlFor="prefixKey" className="text-xs font-medium">
              Prefix
            </Label>
            <Input
              id="prefixKey"
              type="text"
              placeholder="Enter prefix"
              value={trueStartBound ? u8ToString(trueStartBound) : ""} // Prefix input shows the current trueStartBound
              onChange={(e) => handlePrefixInputChange(e.target.value)}
              className="h-9 text-sm"
            />
          </div>
        )}

        <div className="flex items-end gap-2 pt-2 justify-end">
          <Button
            onClick={handleClearFilters}
            size="sm"
            variant="outline"
            className="h-9"
            disabled={
              isLoadingFilteredCount ||
              isLoadingItems ||
              isLoadingUnfilteredCount ||
              downloadScanMutation.isPending
            }
          >
            <XCircle className="mr-2 h-4 w-4" /> Clear Filters
          </Button>
          <Button
            onClick={handleDownloadScan}
            size="sm"
            variant="outline"
            className="h-9"
            disabled={
              downloadScanMutation.isPending ||
              isLoadingItems ||
              isLoadingFilteredCount ||
              (filteredTotalItems ?? 0) === 0
            }
            title={
              (filteredTotalItems ?? 0) === 0
                ? "No items in current scan to download"
                : "Download current scan results as JSONL"
            }
          >
            {downloadScanMutation.isPending ? (
              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
            ) : (
              <Download className="mr-2 h-4 w-4" />
            )}
            Download Scan
          </Button>
        </div>
      </div>
      {renderContent()}
    </div>
  );
};

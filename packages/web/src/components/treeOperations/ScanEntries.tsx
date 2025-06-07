import React, { useEffect, useRef, useState, useMemo } from "react";
import {
  useInfiniteQuery,
  type InfiniteData,
  useQuery,
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
  Download,
  Copy,
  Trash,
} from "lucide-react";
import { toast } from "sonner";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Checkbox } from "@/components/ui/checkbox";
import type { ScanArgsWasm } from "@/lib/types";

import { useDebounce } from "use-debounce";
import { getPrefixScanEndBound } from "@/lib/utils/getPrefixScanEndBound";
import { Tabs, TabsList, TabsTrigger } from "@radix-ui/react-tabs";
import { useDownloadScanMutation } from "./hooks/useDownloadScanMutation";

import {
  Table,
  TableHeader,
  TableBody,
  TableRow,
  TableHead,
  TableCell,
} from "@/components/ui/table";
import { cn } from "@/lib/utils";
import {
  useProllyStore,
  type ProllyTree,
  type ProllyTree,
} from "@/useProllyStore";
import { EntryDialog } from "./EntryDialog";
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

interface ScanEntriesProps {
  prly: ProllyTree | null;
  treePath: string;
  currentRoot: string | null;
  height?: string;
  itemHeight?: number; // Used for estimateSize
}

type ItemsQuery_QueryKey = readonly [
  string,
  string | null, // treePath
  string | null, // currentRoot
  "count" | "scan",
  Omit<ScanArgsWasm, "offset" | "limit">
];

const processScanPageItems = (rawItems: [Uint8Array, Uint8Array][]): Item[] => {
  if (!rawItems) return [];
  return rawItems.map((pair) => ({
    key: u8ToString(pair[0]),
    value: u8ToString(pair[1]),
  }));
};

const ITEMS_PER_PAGE = 50;
const ITEM_HEIGHT = 32;
const KEY_COLUMN_WIDTH_PX = 350;

export const ScanEntries: React.FC<ScanEntriesProps> = ({
  prly,
  treePath,
  currentRoot,
}) => {
  const tree = prly?.tree as WasmProllyTree | null;
  const [scanMode, setScanMode] = useState<"range" | "prefix">("prefix");

  const [trueStartBound, setTrueStartBound] = useState<Uint8Array | null>(null);
  const [trueEndBound, setTrueEndBound] = useState<Uint8Array | null>(null);
  const [trueStartInclusive, setTrueStartInclusive] = useState<boolean>(true);
  const [trueEndInclusive, setTrueEndInclusive] = useState<boolean>(false);

  const [debouncedTrueStartBound] = useDebounce(trueStartBound, 500);
  const [debouncedTrueEndBound] = useDebounce(trueEndBound, 500);
  const [debouncedTrueStartInclusive] = useDebounce(trueStartInclusive, 500);
  const [debouncedTrueEndInclusive] = useDebounce(trueEndInclusive, 500);

  const [keyColumnWidth, setKeyColumnWidth] = useState(KEY_COLUMN_WIDTH_PX);
  const [openEntryDialogKey, setOpenEntryDialogKey] = useState<string | null>(
    null
  );

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
  const tableScrollRef = useRef<HTMLTableElement>(null);

  const { data: unfilteredTotalItems, isLoading: isLoadingUnfilteredCount } =
    useQuery<number, Error, number, readonly (string | null)[]>({
      queryKey: ["tree", treePath, currentRoot, "count"],
      queryFn: async () => {
        if (!tree) return 0;
        return tree.countAllItems() as Promise<number>;
      },
      enabled: !!tree,
      staleTime: Infinity,
      placeholderData: (prev) => prev,
    });

  const { data: filteredTotalItems, isLoading: isLoadingFilteredCount } =
    useQuery<number, Error, number, ItemsQuery_QueryKey>({
      queryKey: ["tree", treePath, currentRoot, "count", appliedScanArgs],
      queryFn: async () => {
        if (!tree) return 0;
        if (!appliedScanArgs.startBound && !appliedScanArgs.endBound) {
          return unfilteredTotalItems ?? 0;
        }
        let count = 0;
        let currentOffset = 0;
        const batchSizeForCount = 1000;
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

  const {
    data: infiniteQueryData,
    fetchNextPage,
    hasNextPage: RqHasNextPage,
    isFetchingNextPage,
    isLoading: isLoadingItems,
    isError: isItemsError,
    error: itemsError,
  } = useInfiniteQuery<
    ScanPage,
    Error,
    InfiniteData<ScanPage, number>,
    ItemsQuery_QueryKey,
    number
  >({
    queryKey: ["tree", treePath, currentRoot, "scan", appliedScanArgs],
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
      if (lastPage.hasNextPage) {
        return lastPageParam + lastPage.items.length;
      }
      return undefined;
    },
    enabled:
      !!tree && filteredTotalItems !== undefined && filteredTotalItems > 0,
  });

  const allFetchedRawItems = useMemo(() => {
    return infiniteQueryData?.pages.flatMap((page) => page.items) ?? [];
  }, [infiniteQueryData]);

  const allDisplayItems = useMemo(() => {
    return processScanPageItems(allFetchedRawItems);
  }, [allFetchedRawItems]);

  const rowVirtualizer = useVirtualizer({
    count: filteredTotalItems ?? 0,
    getScrollElement: () => tableScrollRef.current,
    estimateSize: () => ITEM_HEIGHT, // Provided by prop, used as an estimate
    overscan: 5,
    // No paddingStartIndex or paddingEndIndex needed if we manually apply padding
  });

  const virtualItems = rowVirtualizer.getVirtualItems();

  // Calculate padding for the tbody to simulate the full scroll height
  const paddingTop = virtualItems.length > 0 ? virtualItems[0].start : 0;
  const paddingBottom =
    virtualItems.length > 0
      ? rowVirtualizer.getTotalSize() -
        virtualItems[virtualItems.length - 1].end
      : 0;

  useEffect(() => {
    if (virtualItems.length === 0 || !RqHasNextPage || isFetchingNextPage) {
      return;
    }
    const lastItem = virtualItems[virtualItems.length - 1];
    if (
      lastItem &&
      lastItem.index >= allDisplayItems.length - Math.floor(ITEMS_PER_PAGE / 2)
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

  const downloadScanMutation = useDownloadScanMutation({
    tree,
    treePath,
  });

  const handleDownloadScan = () => {
    if (!tree) {
      toast.error("Tree instance not available for download.");
      return;
    }
    downloadScanMutation.mutate(appliedScanArgs);
  };

  const handleClearFilters = () => {
    setTrueStartBound(null);
    setTrueEndBound(null);
    setTrueStartInclusive(true);
    setTrueEndInclusive(false);
    if (parentRef.current) parentRef.current.scrollTop = 0;
    rowVirtualizer.scrollToOffset(0);
    toast.info("Filters cleared.");
  };

  const handleScanModeChange = (newModeValue: string) => {
    const newMode = newModeValue as "range" | "prefix";
    const oldMode = scanMode;
    setScanMode(newMode);

    if (newMode === "prefix" && oldMode === "range") {
      if (trueStartBound) {
        const prefixEndBound = getPrefixScanEndBound(trueStartBound);
        setTrueStartInclusive(true);
        setTrueEndBound(prefixEndBound === undefined ? null : prefixEndBound);
        setTrueEndInclusive(false);
      } else {
        setTrueStartInclusive(true);
        setTrueEndBound(null);
        setTrueEndInclusive(false);
      }
    }
  };

  const handlePrefixInputChange = (value: string) => {
    const trimmedValue = value.trim();
    if (!trimmedValue) {
      setTrueStartBound(null);
      setTrueStartInclusive(true);
      setTrueEndBound(null);
      setTrueEndInclusive(false);
    } else {
      const newPrefixU8 = toU8(trimmedValue);
      const calculatedEndBound = getPrefixScanEndBound(newPrefixU8);
      setTrueStartBound(newPrefixU8);
      setTrueStartInclusive(true);
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

  const handleRowDelete = (event: React.MouseEvent<HTMLButtonElement>) => {
    // get closest parent with data-row-key attribute
    const row = (event.target as HTMLElement).closest("[data-row-key]");
    if (row) {
      const rowKey = row.getAttribute("data-row-key");
      console.log(rowKey);
      if (rowKey) {
        tree?.delete(toU8(rowKey));
        toast.success("Item deleted successfully.");
        useProllyStore.getState().treeUpdated(treePath);
      }
    }
  };

  const renderContent = () => {
    if (
      isLoadingUnfilteredCount ||
      (isLoadingFilteredCount &&
        filteredTotalItems === undefined &&
        (appliedScanArgs.startBound || appliedScanArgs.endBound))
    ) {
      return (
        <div className="flex flex-col items-center justify-center p-4">
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
        <div className="flex flex-col items-center justify-center p-4">
          <Loader2 className="h-8 w-8 animate-spin text-primary mb-2" />
          <p className="text-sm text-muted-foreground">Fetching items...</p>
        </div>
      );
    }

    if (isItemsError) {
      return (
        <div className="flex flex-col items-center justify-center p-4 text-destructive">
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
        <div className="flex flex-col items-center justify-center p-4 text-center">
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
        <div className="flex flex-col items-center justify-center p-4 text-center">
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
            border: "1px solid hsl(var(--border))",
            borderRadius: "var(--radius-md)",
          }}
          className="bg-muted/20 dark:bg-muted/10 flex-1 overflow-hidden min-h-0 flex flex-col" // Removed relative, not needed for this approach
        >
          {(isFetchingNextPage ||
            (isLoadingItems &&
              allDisplayItems.length === 0 &&
              (filteredTotalItems ?? 0) > 0)) && (
            <div className="sticky top-2 left-1/2 -translate-x-1/2 z-20 bg-background/80 backdrop-blur-sm p-2 rounded-md shadow-lg text-xs flex items-center">
              <Loader2 className="h-4 w-4 animate-spin inline-block mr-1" />
              Loading...
            </div>
          )}
          <Table
            ref={tableScrollRef}
            style={{ position: "relative", borderCollapse: "collapse" }}
            className="h-full overflow-auto"
          >
            <TableHeader className="z-[1] bg-background shadow-sm">
              <TableRow className="flex">
                <TableHead
                  style={{ flex: `0 0 ${keyColumnWidth}px` }}
                  className="text-xs px-3 py-2 h-auto z-[1] bg-background shadow-sm"
                >
                  Key
                </TableHead>
                <TableHead
                  style={{ flex: `1 1 0` }}
                  className="text-xs px-3 py-2 h-auto  z-[2] bg-background shadow-sm "
                >
                  Value
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody
              style={{
                height: rowVirtualizer.getTotalSize(),
                paddingTop: `${paddingTop}px`,
                paddingBottom: `${paddingBottom}px`,
                width: "100%",
                position: "relative",
              }}
            >
              {virtualItems.map((virtualRow) => {
                const item = allDisplayItems[virtualRow.index];
                return (
                  <TableRow
                    data-row-key={item?.key}
                    key={virtualRow.key}
                    ref={rowVirtualizer.measureElement}
                    data-index={virtualRow.index}
                    style={{
                      position: "absolute",
                      top: 0,
                      left: 0,
                      width: "100%",
                      height: `${ITEM_HEIGHT}px`,
                      transform: `translateY(${virtualRow.start}px)`,
                    }}
                    className={cn(
                      "flex",
                      virtualRow.index % 2 === 0
                        ? "hover:bg-muted/20"
                        : "bg-muted/10 dark:bg-black/10 hover:bg-muted/30"
                    )}
                    onPointerDown={() => {
                      setOpenEntryDialogKey(item?.key ?? null);
                    }}
                  >
                    {item ? (
                      <>
                        <TableCell
                          className="font-mono text-sm text-muted-foreground py-1 px-3 align-top overflow-hidden text-ellipsis"
                          title={item.key}
                          style={{
                            flex: `0 0 ${keyColumnWidth}px`,
                            width: `${keyColumnWidth}px`,
                          }}
                        >
                          {item.key}
                        </TableCell>
                        <TableCell
                          className="font-mono text-sm py-1 px-3 align-top text-ellipsis overflow-hidden"
                          style={{
                            flex: `1 1 0`,
                          }}
                          title={item.value}
                        >
                          {item.value}
                        </TableCell>
                      </>
                    ) : (
                      // Placeholder for rows where data might still be loading (though less common with this RQ setup)
                      // or if an item is somehow null/undefined in allDisplayItems
                      <TableCell
                        colSpan={2}
                        className="text-xs text-muted-foreground/70 h-full text-center py-2.5 px-3"
                        style={{ height: `${ITEM_HEIGHT}px` }} // Give placeholder a height
                      >
                        &nbsp;
                      </TableCell>
                    )}
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </div>
      </>
    );
  };

  return (
    <>
      <div className="flex flex-col space-y-3 h-full min-h-0">
        <div className=" shadow-sm space-y-4 rounded-lg bg-card">
          <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-3 mb-3">
            <Tabs
              value={scanMode}
              onValueChange={handleScanModeChange}
              className="w-full sm:w-[20rem]"
            >
              <TabsList className="h-9 grid w-full grid-cols-2">
                <TabsTrigger
                  value="prefix"
                  className="text-xs data-[state=active]:bg-primary/10 rounded-md h-full"
                >
                  <div className="flex items-center justify-center mr-1 px-2 py-1.5">
                    <ArrowRightToLine className="mr-1.5 h-3.5 w-3.5" />
                    Prefix
                  </div>
                </TabsTrigger>
                <TabsTrigger
                  value="range"
                  className="text-xs data-[state=active]:bg-primary/10 rounded-md h-full"
                >
                  <div className="flex items-center justify-center mr-1 px-2 py-1.5">
                    <MoveHorizontal className="mr-1.5 h-3.5 w-3.5" />
                    Range
                  </div>
                </TabsTrigger>
              </TabsList>
            </Tabs>
            <div className="flex items-center gap-2 pt-2 justify-end w-full sm:w-auto">
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
                <XCircle className="mr-2 h-4 w-4" /> Clear
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
                Download
              </Button>
              <div className="text-right text-xs text-muted-foreground pt-1 pr-1">
                {(filteredTotalItems ?? 0).toLocaleString()}
                {unfilteredTotalItems !== undefined &&
                  unfilteredTotalItems !== (filteredTotalItems ?? 0) &&
                  ` /\xa0${unfilteredTotalItems.toLocaleString()}`}
              </div>
            </div>
          </div>

          {scanMode === "range" && (
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4 items-start">
              <div className="flex flex-col space-y-1">
                <div className="flex items-center space-x-2">
                  <Input
                    id="startKey"
                    type="text"
                    placeholder="Start Key"
                    value={trueStartBound ? u8ToString(trueStartBound) : ""}
                    onChange={(e) => handleRangeStartKeyChange(e.target.value)}
                    className=" "
                  />
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
                    Incl.
                  </Label>
                </div>
              </div>
              <div className="flex flex-col space-y-1">
                <div className="flex items-center space-x-2">
                  <Input
                    id="endKey"
                    type="text"
                    placeholder="End Key"
                    value={trueEndBound ? u8ToString(trueEndBound) : ""}
                    onChange={(e) => handleRangeEndKeyChange(e.target.value)}
                    className=" "
                  />
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
                    Incl.
                  </Label>
                </div>
              </div>
            </div>
          )}

          {scanMode === "prefix" && (
            <div className="flex flex-col space-y-1">
              <Input
                id="prefixKey"
                type="text"
                placeholder="Prefix"
                value={trueStartBound ? u8ToString(trueStartBound) : ""}
                onChange={(e) => handlePrefixInputChange(e.target.value)}
              />
            </div>
          )}
        </div>
        {renderContent()}
      </div>
      <EntryDialog
        prly={prly}
        entryKey={openEntryDialogKey ?? ""}
        open={openEntryDialogKey !== null}
        onOpenChange={(open) => {
          if (!open) {
            setOpenEntryDialogKey(null);
          }
        }}
      />
    </>
  );
};

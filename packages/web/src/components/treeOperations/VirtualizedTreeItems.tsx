import React, { useCallback, useEffect, useRef, useState } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
// Make sure this type import is correct for your WASM package
import { type WasmProllyTree } from "prolly-wasm";
import { u8ToString } from "@/lib/prollyUtils";
import { Loader2 } from "lucide-react";
import { toast } from "sonner";

interface Item {
  key: string;
  value: string;
}

interface VirtualizedTreeItemsProps {
  tree: WasmProllyTree; // The active WasmProllyTree instance
  height?: string;
  itemHeight?: number;
  currentRoot: string | null; // The current root of the tree
  // fetchTotalCount: () => Promise<number>; // <<< REMOVE THIS LINE
}

const processRawItems = (rawItems: [Uint8Array, Uint8Array][]): Item[] => {
  return rawItems.map((pair) => ({
    key: u8ToString(pair[0]),
    value: u8ToString(pair[1]),
  }));
};

export const VirtualizedTreeItems: React.FC<VirtualizedTreeItemsProps> = ({
  currentRoot,
  tree,
  height = "500px",
  itemHeight = 60,
}) => {
  const [totalItems, setTotalItems] = useState<number>(0);
  const [isLoadingCount, setIsLoadingCount] = useState<boolean>(true);
  const [fetchedItems, setFetchedItems] = useState<Map<number, Item>>(
    new Map()
  );
  const [isFetchingRange, setIsFetchingRange] = useState<boolean>(false);

  const parentRef = useRef<HTMLDivElement>(null);

  // Fetch total count on component mount or when tree changes
  useEffect(() => {
    setIsLoadingCount(true);
    setFetchedItems(new Map()); // Clear cache when tree instance might have changed

    const getCount = async () => {
      if (!tree) {
        // Guard against tree being undefined/null initially
        setTotalItems(0);
        setIsLoadingCount(false);
        return;
      }
      try {
        const countPromise = tree.countAllItems();
        const count = await (countPromise as Promise<number>);
        setTotalItems(count);
        if (count > 0) {
          // toast.info(`Virtualized list ready for ${count} items.`); // Optional: can be noisy
        } else {
          // toast.info("Tree is empty or count is zero."); // Optional
        }
      } catch (err: any) {
        console.error(
          "VirtualizedTreeItems: Failed to fetch total item count:",
          err
        );
        toast.error(`Failed to get item count: ${err.message || String(err)}`);
        setTotalItems(0);
      } finally {
        setIsLoadingCount(false);
      }
    };

    getCount();
  }, [tree, currentRoot]); // Dependency is now just `tree`

  const rowVirtualizer = useVirtualizer({
    count: totalItems,
    getScrollElement: () => parentRef.current,
    estimateSize: () => itemHeight,
    overscan: 8,
  });

  const virtualItems = rowVirtualizer.getVirtualItems();

  const fetchItemsRange = useCallback(
    async (startIndex: number, endIndex: number) => {
      // ... (rest of fetchItemsRange logic remains the same as previous response)
      const itemsToRequest: { offset: number; limit: number }[] = [];
      let currentRequestRange: { offset: number; limit: number } | null = null;

      for (let i = startIndex; i <= endIndex; i++) {
        if (i < totalItems && !fetchedItems.has(i)) {
          if (currentRequestRange === null) {
            currentRequestRange = { offset: i, limit: 1 };
          } else {
            currentRequestRange.limit++;
          }
        } else {
          if (currentRequestRange) {
            itemsToRequest.push(currentRequestRange);
            currentRequestRange = null;
          }
        }
      }
      if (currentRequestRange) {
        itemsToRequest.push(currentRequestRange);
      }

      if (itemsToRequest.length === 0) return;

      setIsFetchingRange(true);
      try {
        const fetchPromises = itemsToRequest.map(
          (range) =>
            tree.queryItems(
              undefined,
              undefined,
              undefined,
              range.offset,
              range.limit
            ) as Promise<[Uint8Array, Uint8Array][]>
        );

        const resultsArray = await Promise.all(fetchPromises);

        setFetchedItems((prev) => {
          const newMap = new Map(prev);
          resultsArray.forEach((rawItems, rangeIndex) => {
            const processed = processRawItems(rawItems);
            const requestRange = itemsToRequest[rangeIndex];
            processed.forEach((item, itemIdxInProcessedArray) => {
              newMap.set(requestRange.offset + itemIdxInProcessedArray, item);
            });
          });
          return newMap;
        });
      } catch (err: any) {
        console.error(
          "VirtualizedTreeItems: Failed to fetch items range:",
          err
        );
        toast.error(`Error fetching items: ${err.message || String(err)}`);
      } finally {
        setIsFetchingRange(false);
      }
    },
    [tree, fetchedItems, totalItems]
  );

  useEffect(() => {
    if (virtualItems.length > 0 && totalItems > 0 && !isLoadingCount) {
      const firstVisible = virtualItems[0];
      const lastVisible = virtualItems[virtualItems.length - 1];
      if (firstVisible && lastVisible) {
        // Ensure these are defined
        fetchItemsRange(firstVisible.index, lastVisible.index);
      }
    }
  }, [virtualItems, fetchItemsRange, totalItems, isLoadingCount]);

  // ... (rest of the rendering logic for isLoadingCount, totalItems === 0, and the virtualized list itself remains the same)
  if (isLoadingCount) {
    return (
      <div className="flex items-center justify-center p-4" style={{ height }}>
        <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
        <p className="ml-3 text-sm text-muted-foreground">
          Loading total item count...
        </p>
      </div>
    );
  }

  if (totalItems === 0 && !isLoadingCount) {
    // Ensure not to show "No items" while count is loading
    return (
      <p className="text-muted-foreground p-4 text-center text-sm">
        No items in the tree to display.
      </p>
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
        className="bg-muted/20 dark:bg-muted/10"
      >
        <div
          style={{
            height: `${rowVirtualizer.getTotalSize()}px`,
            width: "100%",
            position: "relative",
          }}
        >
          {isFetchingRange &&
            virtualItems.length > 0 &&
            fetchedItems.size < totalItems && (
              <div className="sticky top-2 left-1/2 -translate-x-1/2 z-10 bg-background/80 backdrop-blur-sm p-2 rounded-md shadow-lg text-xs">
                <Loader2 className="h-4 w-4 animate-spin inline-block mr-1" />{" "}
                Loading more...
              </div>
            )}
          {virtualItems.map((virtualRow) => {
            const item = fetchedItems.get(virtualRow.index);
            return (
              <div
                key={virtualRow.key}
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
                  flexDirection: "column",
                  justifyContent: "center",
                  borderBottom: "1px solid hsl(var(--border)/0.3)",
                }}
                className={
                  virtualRow.index % 2 === 0
                    ? "bg-transparent"
                    : "bg-muted/10 dark:bg-black/10"
                }
              >
                {item ? (
                  <>
                    <div className="flex flex-row items-center justify-between gap-4">
                      <div className="flex-1 text-right">{item.key}</div>
                      <div className="flex-1 text-left">{item.value}</div>
                    </div>
                  </>
                ) : (
                  <div className="text-xs text-muted-foreground animate-pulse">
                    Loading item {virtualRow.index + 1}...
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </div>
      {totalItems > 0 && (
        <div className=" backdrop-blur-sm p-2 rounded-md  text-xs">
          Total items: {totalItems}
        </div>
      )}
    </>
  );
};

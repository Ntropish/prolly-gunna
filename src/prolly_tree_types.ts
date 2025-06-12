/**
 * Configuration for creating a new ProllyTree.
 * All fields are optional and will use reasonable defaults on the Rust side if not provided.
 * Corresponds to the Rust `TreeConfig` struct.
 */
export interface TreeConfigOptions {
  targetFanout?: number | null;
  minFanout?: number | null;
  cdcMinSize?: number | null;
  cdcAvgSize?: number | null;
  cdcMaxSize?: number | null;
  maxInlineValueSize?: number | null;
}

/**
 * Options for the scanItems operation.
 * All fields are optional and will use reasonable defaults on the Rust side if not provided.
 * Corresponds to the Rust `ScanArgs` struct.
 */
export interface ScanOptions {
  startBound?: Uint8Array | null;
  endBound?: Uint8Array | null;
  startInclusive?: boolean | null;
  endInclusive?: boolean | null;
  reverse?: boolean | null;
  /** Corresponds to u64 in Rust. Use JavaScript BigInt for large numbers. */
  offset?: bigint | number | null;
  limit?: number | null;
}

/**
 * Represents a key-value pair for batch insertion, typically `[Uint8Array, Uint8Array]`.
 */
export type BatchItem = [Uint8Array, Uint8Array];

/**
 * TypeScript interface for the `ScanPage` class exposed from Rust.
 * This MUST match the getters defined in `src/wasm_bridge.rs::ScanPage`.
 * When `wasm-bindgen` generates the .d.ts for ScanPage, it creates property-like
 * accessors for getters.
 */
export interface IScanPage {
  /** Items in the current page. Accesses the `items()` getter in Rust. */
  readonly items: BatchItem[];
  /** Indicates if there is a next page. Accesses the `hasNextPage()` getter. */
  readonly hasNextPage: boolean;
  /** Indicates if there is a previous page. Accesses the `hasPreviousPage()` getter. */
  readonly hasPreviousPage: boolean;
  /** Cursor for the next page. Accesses the `nextPageCursor()` getter. */
  readonly nextPageCursor: Uint8Array | null;
  /** Cursor for the previous page. Accesses the `previousPageCursor()` getter. */
  readonly previousPageCursor: Uint8Array | null;
}

/**
 * Represents a diff entry when comparing two tree versions.
 * This corresponds to the Rust `DiffEntry` struct.
 */
export interface DiffEntry {
  key: Uint8Array;
  leftValue?: Uint8Array | null;
  rightValue?: Uint8Array | null;
}

// --- Resolved Promise Return Type Aliases ---

/** The resolved value of the `get` method: the value (Uint8Array) or null if not found. */
export type GetFnReturn = Uint8Array | null;
/** The synchronous return value of the `getSync` method. Throws on error. */
export type GetSyncFnReturn = Uint8Array | null;
/** The `insert` method resolves to void (or undefined in JS) upon completion. */
export type InsertFnReturn = void;
/** The synchronous return value of the `insertSync` method. Throws on error. */
export type InsertSyncFnReturn = void;
/** The `insertBatch` method resolves to void (or undefined in JS) upon completion. */
export type InsertBatchFnReturn = void;
/** The `delete` method resolves to a boolean indicating if the key was found and deleted. */
export type DeleteFnReturn = boolean;
/** The synchronous return value of the `deleteSync` method. Throws on error. */
export type DeleteSyncFnReturn = boolean;
/** The `checkout` method resolves to void (or undefined in JS) upon completion. */
export type CheckoutFnReturn = void;
/** The `getRootHash` method resolves to the root hash (Uint8Array) or null if the tree is empty. */
export type GetRootHashFnReturn = Uint8Array | null;
/** The `exportChunks` method resolves to a Map of chunk hashes to chunk data. */
export type ExportChunksFnReturn = Map<Uint8Array, Uint8Array>;
/** The `diffRoots` method resolves to an array of DiffEntry objects. */
export type DiffRootsFnReturn = DiffEntry[];
/** The `triggerGc` method resolves to the number of chunks garbage collected. */
export type TriggerGcFnReturn = number;
/** The `getTreeConfig` method resolves to the tree's current configuration. */
export type GetTreeConfigFnReturn = TreeConfigOptions;
/** The `scanItems` method resolves to a page of scanned items. */
export type ScanItemsFnReturn = IScanPage;
/** The `countAllItems` method resolves to the total count of items in the tree. */
export type CountAllItemsFnReturn = number;
/** The `hierarchyScan` method resolves to a page of hierarchy scan results. */
export type HierarchyScanFnReturn = Promise<HierarchyScanPageResult>;
/** The `saveTreeToFileBytes` method resolves to a Uint8Array containing the tree's data. */
export type ExportTreeToFileFnReturn = Promise<Uint8Array>;
/** The `loadTreeFromFileBytes` method resolves to a PTree instance. */
export type LoadTreeFromFileBytesFnReturn = Promise<PTree>;

/**
 * The resolved value of the `PTreeCursor.next()` method.
 * It's an object indicating if the cursor is done, and if not, the current [key, value] pair.
 */
export type CursorNextReturn =
  | { done: false; value: [Uint8Array, Uint8Array] }
  | { done: true; value?: undefined };

// --- Added for Hierarchy Scan ---
export interface HierarchyScanOptions {
  startKey?: Uint8Array;
  maxDepth?: number;
  limit?: number;
}

/**
 * Represents an item encountered during a hierarchy scan.
 * The specific fields depend on the type of item.
 */

export interface HierarchyScanPageResult {
  items: HierarchyItem[];
  hasNextPage: boolean;
  nextPageCursorToken?: string;
}

export type HierarchyItem =
  | {
      type: "Node";
      hash: Uint8Array;
      level: number;
      isLeaf: boolean;
      numEntries: number;
      pathIndices: number[];
    }
  | {
      type: "InternalEntry";
      parentHash: Uint8Array;
      entryIndex: number;
      boundaryKey: Uint8Array;
      childHash: Uint8Array;
      numItemsSubtree: number;
    }
  | {
      type: "LeafEntry";
      parentHash: Uint8Array;
      entryIndex: number;
      key: Uint8Array;
      valueReprType: string;
      valueHash?: Uint8Array;
      valueSize: number;
    };

export interface HierarchyScanOptions {
  startKey?: Uint8Array;
  maxDepth?: number;
  limit?: number;
  offset?: number;
}

export interface HierarchyScanPageResult {
  items: HierarchyItem[];
  hasNextPage: boolean;
  nextPageCursorToken?: string;
}

/* tslint:disable */
/* eslint-disable */
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
/** The `insert` method resolves to void (or undefined in JS) upon completion. */
export type InsertFnReturn = void;
/** The `insertBatch` method resolves to void (or undefined in JS) upon completion. */
export type InsertBatchFnReturn = void;
/** The `delete` method resolves to a boolean indicating if the key was found and deleted. */
export type DeleteFnReturn = boolean;
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


export class HierarchyScanPage {
  private constructor();
  free(): void;
  readonly items: Array<any>;
  readonly hasNextPage: boolean;
  readonly nextPageCursorToken: string | undefined;
}
export class IndexedDBStore {
  free(): void;
  constructor(db_name: string);
  readonly name: string;
}
export class PTree {
  free(): void;
  constructor(options?: TreeConfigOptions | null);
  static load(root_hash_js: Uint8Array | null | undefined, chunks_js: Map<any, any>, tree_config_options?: TreeConfigOptions | null): Promise<LoadTreeFromFileBytesFnReturn>;
  get(key_js: Uint8Array): Promise<GetFnReturn>;
  insert(key_js: Uint8Array, value_js: Uint8Array): Promise<InsertFnReturn>;
  insertBatch(items_js_val: any): Promise<InsertBatchFnReturn>;
  delete(key_js: Uint8Array): Promise<DeleteFnReturn>;
  checkout(hash_js?: Uint8Array | null): Promise<CheckoutFnReturn>;
  getRootHash(): Promise<GetRootHashFnReturn>;
  exportChunks(): Promise<ExportChunksFnReturn>;
  cursorStart(): Promise<any>;
  seek(key_js: Uint8Array): Promise<any>;
  diffRoots(_root_h_left_js?: Uint8Array | null, root_h_right_js?: Uint8Array | null): Promise<DiffRootsFnReturn>;
  triggerGc(live_hashes_js_val: any): Promise<TriggerGcFnReturn>;
  getTreeConfig(): Promise<GetTreeConfigFnReturn>;
  scanItems(options: ScanOptions): Promise<ScanItemsFnReturn>;
  countAllItems(): Promise<CountAllItemsFnReturn>;
  hierarchyScan(options?: HierarchyScanOptions | null): Promise<HierarchyScanFnReturn>;
  saveTreeToFileBytes(description?: string | null): Promise<ExportTreeToFileFnReturn>;
  static loadTreeFromFileBytes(file_bytes_js: Uint8Array): Promise<LoadTreeFromFileBytesFnReturn>;
}
export class PTreeCursor {
  private constructor();
  free(): void;
  next(): Promise<CursorNextReturn>;
}
export class ScanPage {
  private constructor();
  free(): void;
  readonly items: Array<any>;
  readonly hasNextPage: boolean;
  readonly hasPreviousPage: boolean;
  readonly nextPageCursor: Uint8Array | undefined;
  readonly previousPageCursor: Uint8Array | undefined;
}

export type InitInput = RequestInfo | URL | Response | BufferSource | WebAssembly.Module;

export interface InitOutput {
  readonly memory: WebAssembly.Memory;
  readonly __wbg_ptree_free: (a: number, b: number) => void;
  readonly __wbg_ptreecursor_free: (a: number, b: number) => void;
  readonly ptreecursor_next: (a: number) => any;
  readonly ptree_new: (a: number) => [number, number, number];
  readonly ptree_load: (a: number, b: any, c: number) => any;
  readonly ptree_get: (a: number, b: any) => any;
  readonly ptree_insert: (a: number, b: any, c: any) => any;
  readonly ptree_insertBatch: (a: number, b: any) => any;
  readonly ptree_delete: (a: number, b: any) => any;
  readonly ptree_checkout: (a: number, b: number) => any;
  readonly ptree_getRootHash: (a: number) => any;
  readonly ptree_exportChunks: (a: number) => any;
  readonly ptree_cursorStart: (a: number) => any;
  readonly ptree_seek: (a: number, b: any) => any;
  readonly ptree_diffRoots: (a: number, b: number, c: number) => any;
  readonly ptree_triggerGc: (a: number, b: any) => any;
  readonly ptree_getTreeConfig: (a: number) => any;
  readonly ptree_scanItems: (a: number, b: any) => any;
  readonly ptree_countAllItems: (a: number) => any;
  readonly ptree_hierarchyScan: (a: number, b: number) => any;
  readonly ptree_saveTreeToFileBytes: (a: number, b: number, c: number) => any;
  readonly ptree_loadTreeFromFileBytes: (a: any) => any;
  readonly __wbg_indexeddbstore_free: (a: number, b: number) => void;
  readonly indexeddbstore_new: (a: number, b: number) => any;
  readonly indexeddbstore_name: (a: number) => [number, number];
  readonly __wbg_scanpage_free: (a: number, b: number) => void;
  readonly scanpage_items: (a: number) => any;
  readonly scanpage_has_next_page: (a: number) => number;
  readonly scanpage_has_previous_page: (a: number) => number;
  readonly scanpage_next_page_cursor: (a: number) => any;
  readonly scanpage_previous_page_cursor: (a: number) => any;
  readonly __wbg_hierarchyscanpage_free: (a: number, b: number) => void;
  readonly hierarchyscanpage_items: (a: number) => any;
  readonly hierarchyscanpage_has_next_page: (a: number) => number;
  readonly hierarchyscanpage_next_page_cursor_token: (a: number) => [number, number];
  readonly __wbindgen_malloc: (a: number, b: number) => number;
  readonly __wbindgen_realloc: (a: number, b: number, c: number, d: number) => number;
  readonly __wbindgen_exn_store: (a: number) => void;
  readonly __externref_table_alloc: () => number;
  readonly __wbindgen_export_4: WebAssembly.Table;
  readonly __externref_drop_slice: (a: number, b: number) => void;
  readonly __wbindgen_free: (a: number, b: number, c: number) => void;
  readonly __wbindgen_export_7: WebAssembly.Table;
  readonly __externref_table_dealloc: (a: number) => void;
  readonly closure193_externref_shim: (a: number, b: number, c: any) => void;
  readonly closure215_externref_shim: (a: number, b: number, c: any, d: any) => void;
  readonly __wbindgen_start: () => void;
}

export type SyncInitInput = BufferSource | WebAssembly.Module;
/**
* Instantiates the given `module`, which can either be bytes or
* a precompiled `WebAssembly.Module`.
*
* @param {{ module: SyncInitInput }} module - Passing `SyncInitInput` directly is deprecated.
*
* @returns {InitOutput}
*/
export function initSync(module: { module: SyncInitInput } | SyncInitInput): InitOutput;

/**
* If `module_or_path` is {RequestInfo} or {URL}, makes a request and
* for everything else, calls `WebAssembly.instantiate` directly.
*
* @param {{ module_or_path: InitInput | Promise<InitInput> }} module_or_path - Passing `InitInput` directly is deprecated.
*
* @returns {Promise<InitOutput>}
*/
export default function __wbg_init (module_or_path?: { module_or_path: InitInput | Promise<InitInput> } | InitInput | Promise<InitInput>): Promise<InitOutput>;

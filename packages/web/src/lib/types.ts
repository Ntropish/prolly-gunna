export interface ScanArgsWasm {
  startBound?: Uint8Array;
  endBound?: Uint8Array;
  startInclusive?: boolean;
  endInclusive?: boolean;
  reverse?: boolean;
  offset?: number; // Corresponds to u64, JS number should be fine
  limit?: number;
}

/**
 * Matches the structure of ScanPage as returned from Wasm.
 */
export interface ScanPageWasm {
  items: [Uint8Array, Uint8Array][];
  hasNextPage: boolean;
  hasPreviousPage: boolean;
  nextPageCursor?: Uint8Array;
  previousPageCursor?: Uint8Array;
}

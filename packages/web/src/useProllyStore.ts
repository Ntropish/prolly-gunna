// src/useProllyStore.ts

import { create } from "zustand";
import { WasmProllyTree } from "prolly-wasm";
import { u8ToHex } from "@/lib/prollyUtils";
import type { TreeState, JsTreeConfigType } from "./useAppStore";

/**
 * Metadata for a tree file discovered in OPFS.
 */
export interface ProllyFileMeta {
  /** The plain file name (e.g. `my‑tree.prly`) */
  name: string;
  /** Absolute path from the OPFS root.  */
  path: string;
  /** File byte length */
  size: number;
}

/**
 * In‑memory representation of a prolly tree that knows what its on‑disk
 * root‑hash looked like when we loaded / last saved it.
 */
export interface ProllyTreeEntry extends TreeState {
  /** The root‑hash that was stored on disk the last time the tree was saved. */
  lastSavedRootHash: string | null;
  /** `true` when `rootHash !== lastSavedRootHash`. */
  isDirty: boolean;
  /** Convenience handle back to the origin OPFS FileHandle. */
  fileHandle: FileSystemFileHandle | null;
}

interface ProllyStoreState {
  /** All `.prly` files we have discovered. */
  files: ProllyFileMeta[];
  /** Active tree instances, keyed by their `id`. */
  trees: Record<string, ProllyTreeEntry>;
  /** Flag while the initial OPFS scan / load is running */
  initializing: boolean;

  /** Kick‑off a fresh scan of OPFS and load every tree file we find. */
  initialize: () => Promise<void>;
  /** Manually refresh a tree’s root‑hash and update its dirty flag. */
  refreshRootHash: (treeId: string) => Promise<void>;
  /** Persist a tree back to its originating OPFS file. */
  saveTree: (treeId: string) => Promise<void>;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Asynchronously iterate a directory tree and yield every file handle that
 * ends with `.prly`.  Currently a shallow scan – extend as required. */
async function* findPrlyFiles(
  dir: FileSystemDirectoryHandle
): AsyncGenerator<
  { name: string; handle: FileSystemFileHandle },
  void,
  unknown
> {
  for await (const [name, handle] of dir.entries()) {
    if (handle.kind === "file" && name.toLowerCase().endsWith(".prly")) {
      yield { name, handle };
    }
    // 👉 If you store trees in sub‑directories, recurse here.
  }
}

async function fileHandleToMeta(
  path: string,
  name: string,
  handle: FileSystemFileHandle
): Promise<ProllyFileMeta> {
  const file = await handle.getFile();
  return { name, path, size: file.size };
}

async function loadTreeFromFileHandle(
  name: string,
  handle: FileSystemFileHandle
): Promise<ProllyTreeEntry | null> {
  try {
    const file = await handle.getFile();
    const bytes = new Uint8Array(await file.arrayBuffer());

    // Wasm helper provided by your existing code
    const tree = await WasmProllyTree.loadTreeFromFileBytes(bytes);

    const rootHashU8 = await tree.getRootHash();
    const treeConfig = (await tree.getTreeConfig()) as JsTreeConfigType;

    const rootHashHex = rootHashU8 ? u8ToHex(rootHashU8) : null;

    const treeId = name; // ↳ keep stable; adjust if you prefer a nicer id

    return {
      id: treeId,
      tree,
      rootHash: rootHashHex,
      treeConfig,
      lastError: null,
      lastValue: null,
      items: [],
      chunks: [],
      diffResult: [],
      gcCollectedCount: null,
      // — Dirty‑tracking fields —
      lastSavedRootHash: rootHashHex,
      isDirty: false,
      fileHandle: handle,
    };
  } catch (err) {
    console.error(`⚠️  Failed to load tree ${name}:`, err);
    return null;
  }
}

// ---------------------------------------------------------------------------
// Store implementation
// ---------------------------------------------------------------------------

export const useProllyStore = create<ProllyStoreState>()((set, get) => ({
  files: [],
  trees: {},
  initializing: false,

  initialize: async () => {
    if (get().initializing) return; // no‑op re‑entry guard

    set({ initializing: true });
    try {
      const opfsRoot = await navigator.storage.getDirectory();
      const newFiles: ProllyFileMeta[] = [];
      const newTrees: Record<string, ProllyTreeEntry> = {};

      for await (const { name, handle } of findPrlyFiles(opfsRoot)) {
        const meta = await fileHandleToMeta(name, name, handle);
        newFiles.push(meta);

        const treeEntry = await loadTreeFromFileHandle(name, handle);
        if (treeEntry) {
          newTrees[treeEntry.id] = treeEntry;
        }
      }

      set({ files: newFiles, trees: newTrees });
    } catch (err) {
      console.error("⚠️  OPFS scan failed:", err);
    } finally {
      set({ initializing: false });
    }
  },

  refreshRootHash: async (treeId: string) => {
    const treeEntry = get().trees[treeId];
    if (!treeEntry) return;

    try {
      const rootHashU8 = await treeEntry.tree.getRootHash();
      const newRoot = rootHashU8 ? u8ToHex(rootHashU8) : null;
      const isDirty = newRoot !== treeEntry.lastSavedRootHash;
      set((s) => ({
        trees: {
          ...s.trees,
          [treeId]: { ...treeEntry, rootHash: newRoot, isDirty },
        },
      }));
    } catch (err) {
      console.error(`⚠️  Failed to refresh root hash for ${treeId}:`, err);
    }
  },

  saveTree: async (treeId: string) => {
    const treeEntry = get().trees[treeId];

    console.log("treeEntry", treeEntry);
    if (!treeEntry || !treeEntry.fileHandle) return;
    console.log("treeEntry.fileHandle", treeEntry.fileHandle);

    try {
      // Delegate to your existing save procedure – assuming `tree.saveToBytes()`
      const bytes = await treeEntry.tree.saveTreeToFileBytes();
      const writable = await treeEntry.fileHandle.createWritable();
      await writable.write(bytes);
      await writable.close();

      // Update housekeeping
      await get().refreshRootHash(treeId);
      set((s) => ({
        trees: {
          ...s.trees,
          [treeId]: {
            ...s.trees[treeId],
            lastSavedRootHash: s.trees[treeId].rootHash,
            isDirty: false,
          },
        },
      }));
    } catch (err) {
      console.error(`⚠️  Failed to save tree ${treeId}:`, err);
    }
  },
}));

// ---------------------------------------------------------------------------
// Usage quick‑start
// ---------------------------------------------------------------------------
// import { useProllyStore } from "@/useProllyStore";
//
// // kick‑off once in your root component
// useEffect(() => {
//   useProllyStore.getState().initialize();
// }, []);
//
// const trees = useProllyStore((s) => Object.values(s.trees));
// const saving = useProllyStore((s) => s.saveTree);
// ---------------------------------------------------------------------------

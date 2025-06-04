import { create } from "zustand";
import { WasmProllyTree, type TreeConfigOptions } from "prolly-wasm";
import { u8ToHex } from "@/lib/prollyUtils";
import { uuidv7 } from "uuidv7";
import { produce } from "immer";
import { adjectives, colors } from "unique-names-generator";
import { uniqueNamesGenerator } from "unique-names-generator";
import { animals } from "unique-names-generator";

export interface ProllyTree {
  path: string;
  tree: WasmProllyTree;
  lastSavedRootHash: string | null;
  rootHash: string | null;
  treeConfig: TreeConfigOptions | null;
  lastError: string | null;
  fileHandle: FileSystemFileHandle | null;
}

interface ProllyStoreState {
  trees: Record<string, ProllyTree>;

  /** Flag while the initial OPFS scan / load is running */
  initializing: boolean;

  saveTree: (treeId: string) => Promise<void>;
  createNewTree: (
    options?: Partial<Pick<ProllyTree, "treeConfig" | "path" | "tree">>
  ) => Promise<string>;
  deleteTree: (treeId: string) => Promise<void>;
  renameTree: (treeId: string, newName: string) => Promise<void>;

  refreshRootHash: (treePath: string) => Promise<void>;

  treeUpdated: (treePath: string) => Promise<void>;
  treeError: (treePath: string, error: string) => Promise<void>;
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

async function fileHandleToTree(
  name: string,
  handle: FileSystemFileHandle
): Promise<ProllyTree> {
  const file = await handle.getFile();
  const bytes = new Uint8Array(await file.arrayBuffer());

  // Wasm helper provided by your existing code
  const tree = await WasmProllyTree.loadTreeFromFileBytes(bytes);

  const rootHashU8 = await tree.getRootHash();
  const rootHashHex = rootHashU8 ? u8ToHex(rootHashU8) : null;

  const treeConfig = await tree.getTreeConfig();

  return {
    path: name,
    tree,
    lastSavedRootHash: rootHashHex,
    rootHash: rootHashHex,
    treeConfig,
    lastError: null,
    fileHandle: handle,
  };
}

// ---------------------------------------------------------------------------
// Store implementation
// ---------------------------------------------------------------------------

export const useProllyStore = create<ProllyStoreState>()((set, get) => {
  async function initialize() {
    try {
      const opfsRoot = await navigator.storage.getDirectory();
      const newTrees: Record<string, ProllyTree> = {};

      for await (const { name, handle } of findPrlyFiles(opfsRoot)) {
        const tree = await fileHandleToTree(name, handle);
        newTrees[tree.path] = tree;
      }

      set({ trees: newTrees });
    } catch (err) {
      console.error("⚠️  OPFS scan failed:", err);
    } finally {
      set({ initializing: false });
    }
  }

  initialize();

  return {
    trees: {},
    initializing: true,

    refreshRootHash: async (treePath: string) => {
      const treeEntry = get().trees[treePath];
      if (!treeEntry) return;

      try {
        const rootHashU8 = await treeEntry.tree.getRootHash();
        const newRoot = rootHashU8 ? u8ToHex(rootHashU8) : null;
        const isDirty = newRoot !== treeEntry.lastSavedRootHash;
        set((s) => ({
          trees: {
            ...s.trees,
            [treePath]: { ...treeEntry, rootHash: newRoot, isDirty },
          },
        }));
      } catch (err) {
        console.error(`⚠️  Failed to refresh root hash for ${treePath}:`, err);
      }
    },

    saveTree: async (treePath: string) => {
      const state = get();
      const treeEntry = state.trees[treePath];
      if (!treeEntry) return; // Unknown id.

      try {
        // 1️⃣ Ensure we have a fileHandle – create one if missing.
        let fileHandle = treeEntry.fileHandle;
        if (!fileHandle) {
          const opfsRoot = await navigator.storage.getDirectory();
          const filename = treePath.toLowerCase().endsWith(".prly")
            ? treePath
            : `${treePath}.prly`;

          fileHandle = await opfsRoot.getFileHandle(filename, { create: true });

          // Add/Update the files list with fresh metadata.
          // Patch the tree entry with the new handle.
          set((s) => ({
            trees: produce(s.trees, (draft) => {
              draft[treePath].fileHandle = fileHandle;
            }),
          }));
        }

        // 2️⃣ Serialize and write bytes.
        const bytes = await treeEntry.tree.saveTreeToFileBytes();
        const writable = await fileHandle.createWritable();
        await writable.write(bytes);
        await writable.close();

        const rootHash = await treeEntry.tree.getRootHash();

        const rootHashHex = rootHash ? u8ToHex(rootHash).toString() : null;

        set((s) => ({
          trees: produce(s.trees, (draft) => {
            draft[treePath].rootHash = rootHashHex;
            draft[treePath].lastSavedRootHash = rootHashHex;
          }),
        }));
      } catch (err) {
        console.error(`⚠️  Failed to save tree ${treePath}:`, err);
      }
    },

    createNewTree: async (
      options?: Partial<Pick<ProllyTree, "treeConfig" | "path" | "tree">>
    ) => {
      const tree = options?.tree ?? new WasmProllyTree();
      const cfg = options?.treeConfig ?? (await tree.getTreeConfig());
      const root = await tree.getRootHash();
      const path =
        options?.path ??
        uniqueNamesGenerator({
          dictionaries: [adjectives, animals],
          separator: "-",
          length: 2,
        }) + ".prly";

      set((s) => ({
        trees: produce(s.trees, (draft) => {
          draft[path] = {
            tree,
            treeConfig: cfg,
            rootHash: root ? u8ToHex(root) : null,
            lastSavedRootHash: null,
            lastError: null,
            fileHandle: null,
            path,
          };
        }),
      }));

      await get().saveTree(path);

      return path;
    },

    deleteTree: async (treePath: string) => {
      const treeEntry = get().trees[treePath];
      if (!treeEntry) return;

      if (treeEntry.fileHandle) {
        // call removeEntry on the parent directory
        const opfsRoot = await navigator.storage.getDirectory();
        await opfsRoot.removeEntry(treeEntry.fileHandle.name);
      }

      set((s) => ({
        trees: produce(s.trees, (draft) => {
          delete draft[treePath];
        }),
      }));
    },

    renameTree: async (treePath: string, newName: string) => {
      throw new Error("Not implemented");
    },

    treeUpdated: async (treePath: string) => {
      const treeEntry = get().trees[treePath];
      if (!treeEntry) return;

      try {
        const rootHashU8 = await treeEntry.tree.getRootHash();
        const newRoot = rootHashU8 ? u8ToHex(rootHashU8) : null;
        set((s) => ({
          trees: produce(s.trees, (draft) => {
            draft[treePath].rootHash = newRoot;
            draft[treePath].lastError = null;
          }),
        }));
        await get().saveTree(treePath);
      } catch (err) {
        console.error(`⚠️  Failed to reload hash for ${treePath}:`, err);
      }
    },

    treeError: async (treePath: string, error: string) => {
      const treeEntry = get().trees[treePath];
      if (!treeEntry) return;

      try {
        const rootHashU8 = await treeEntry.tree.getRootHash();
        const newRoot = rootHashU8 ? u8ToHex(rootHashU8) : null;
        set((s) => ({
          trees: produce(s.trees, (draft) => {
            draft[treePath].rootHash = newRoot;
            draft[treePath].lastError = error;
          }),
        }));
      } catch (err) {
        console.error(`⚠️  Failed to reload hash for ${treePath}:`, err);
      }
    },
  };
});

import type { WasmProllyTree } from "prolly-wasm";
import { create } from "zustand";
import { persist, createJSONStorage } from "zustand/middleware";

interface AppStore {
  trees: WasmProllyTree[];
}

export const useAppStore = create<AppStore>()(
  persist(
    (set) => ({
      trees: [],
    }),
    {
      name: "app-storage",
      storage: createJSONStorage(() => sessionStorage),
    }
  )
);

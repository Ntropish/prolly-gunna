// src/App.tsx
import { useEffect, useState, type ChangeEvent, useRef, useMemo } from "react";
import { WasmProllyTree } from "prolly-wasm";

import { useProllyStore } from "@/useProllyStore"; //  ← NEW STORE
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { TreeInterface } from "@/components/TreeInterface";
import { Toaster, toast } from "sonner";
import { Loader2, FileUp, PlusCircle, TreeDeciduous } from "lucide-react";
import { useNavigate, useParams } from "react-router";

export default function App() {
  const navigate = useNavigate();
  // ────────────────────────────────────────────────────────────
  //  1.  Store selectors
  // ────────────────────────────────────────────────────────────
  const treesList = useProllyStore((s) => s.trees);
  const trees = useMemo(
    () =>
      Object.values(treesList).map((tree) => ({
        ...tree,
      })),
    [treesList]
  );
  const initializing = useProllyStore((s) => s.initializing);

  // ────────────────────────────────────────────────────────────
  //  2.  UI state
  // ────────────────────────────────────────────────────────────
  // const [activeTab, setActiveTab] = useState<string>();
  const { treeId } = useParams();

  // keep activeTab valid
  useEffect(() => {
    if (!treeId && trees.length) {
      navigate(`/${trees[0].id}`);
    }
    if (treeId && !trees.find((t) => t.id === treeId)) {
      navigate(`/${trees.length ? trees[0].id : undefined}`);
    }
  }, [trees, treeId, navigate]);

  const tree = useMemo(() => {
    return trees.find((t) => t.id === treeId);
  }, [trees, treeId]);

  // ────────────────────────────────────────────────────────────
  //  4.  Render
  // ────────────────────────────────────────────────────────────
  return (
    <div className="container mx-auto p-2 sm:p-1 space-y-1 min-h-screen">
      <Toaster richColors />

      {/* HEADER */}
      <header className="flex flex-col sm:flex-row justify-between items-center gap-4 border-b">
        <div className="flex items-center gap-2 ml-11">
          <TreeDeciduous className="h-8 w-8 text-muted-foreground" />
          <h1 className="text-3xl font-light tracking-tight text-muted-foreground">
            PBT
          </h1>
        </div>
      </header>

      {tree && <TreeInterface treeState={tree} />}
    </div>
  );
}

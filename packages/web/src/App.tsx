// src/App.tsx
import { useEffect, useMemo } from "react";

import { useProllyStore } from "@/useProllyStore"; //  ← NEW STORE
import { TreeInterface } from "@/components/TreeInterface";
import { Toaster } from "sonner";
import { TreeDeciduous } from "lucide-react";
import { useNavigate, useParams } from "react-router";
import { keyBy } from "lodash-es";

export default function App() {
  const navigate = useNavigate();

  const treesList = useProllyStore((s) => s.trees);
  const trees = useMemo(() => keyBy(treesList, "path"), [treesList]);
  const initializing = useProllyStore((s) => s.initializing);

  const { treeId } = useParams();

  // keep activeTab valid
  useEffect(() => {
    if (initializing) return;
    if (!treeId && trees.length) {
      if (trees.length) {
        navigate(`/${trees[0].path}`);
      } else {
        navigate("/");
      }
    }
    if (treeId) {
      const tree = trees[treeId];
      if (!tree) {
        if (trees.length) {
          navigate(`/${trees[0].path}`);
        } else {
          navigate("/");
        }
      }
    }
  }, [trees, treeId, navigate, initializing]);

  const tree = useMemo(() => {
    return treeId && trees[treeId];
  }, [trees, treeId]);

  return (
    <div className="container mx-auto p-2 sm:p-1 space-y-1 h-screen overflow-hidden flex flex-col">
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

      <div className="flex-1 flex flex-col min-h-0 overflow-hidden">
        {tree && <TreeInterface treeState={tree} />}
      </div>
    </div>
  );
}

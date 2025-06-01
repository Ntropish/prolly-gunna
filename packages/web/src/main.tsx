import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "./index.css";
import App from "./App.tsx";
import init from "prolly-wasm";
import { BrowserRouter, Route, Routes } from "react-router";

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { SidebarProvider, SidebarTrigger } from "@/components/ui/sidebar";
import { AppSidebar } from "./components/app-sidebar.tsx";

const queryClient = new QueryClient();

init();

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <BrowserRouter>
      <QueryClientProvider client={queryClient}>
        <SidebarProvider>
          <AppSidebar />
          <main className="flex flex-col gap-4 overflow-y-hidden flex-1 relative">
            <SidebarTrigger className="absolute top-2 left-2" />
            <Routes>
              <Route index element={<App />} />
              <Route path="/:treeId" element={<App />} />
            </Routes>
          </main>
        </SidebarProvider>
      </QueryClientProvider>
    </BrowserRouter>
  </StrictMode>
);

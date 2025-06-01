import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarHeader,
  SidebarMenuButton,
  SidebarMenuItem,
} from "@/components/ui/sidebar";
import { useProllyStore } from "@/useProllyStore";
import { Link, useLocation } from "react-router";

export function AppSidebar() {
  const trees = useProllyStore((s) => s.trees);
  const location = useLocation();
  return (
    <Sidebar>
      <SidebarHeader />
      <SidebarContent>
        <SidebarGroup className="list-none">
          {Object.entries(trees).map(([id, tree]) => (
            <SidebarMenuItem key={id}>
              <SidebarMenuButton
                asChild
                isActive={location.pathname === `/${id}`}
              >
                <Link to={`/${id}`}>
                  <span className="text-xs text-overflow-ellipsis overflow-hidden font-mono">
                    {tree.id}
                  </span>
                  {tree.rootHash !== tree.lastSavedRootHash && "*"}
                </Link>
              </SidebarMenuButton>
            </SidebarMenuItem>
          ))}

          {/* <SidebarMenuItem key="ingredients">
            <SidebarMenuButton asChild>
              <Link to="/admin/ingredients">Ingredients</Link>
            </SidebarMenuButton>
          </SidebarMenuItem>

          <SidebarMenuItem key="potions">
            <SidebarMenuButton asChild>
              <Link to="/admin/potions">Potions</Link>
            </SidebarMenuButton>
          </SidebarMenuItem>

          <SidebarMenuItem key="effects">
            <SidebarMenuButton asChild>
              <Link to="/admin/effects">Effects</Link>
            </SidebarMenuButton>
          </SidebarMenuItem>

          <SidebarMenuItem key="items">
            <SidebarMenuButton asChild>
              <Link to="/admin/items">Items</Link>
            </SidebarMenuButton>
          </SidebarMenuItem> */}
        </SidebarGroup>
        <SidebarGroup />
      </SidebarContent>
      <SidebarFooter />
    </Sidebar>
  );
}

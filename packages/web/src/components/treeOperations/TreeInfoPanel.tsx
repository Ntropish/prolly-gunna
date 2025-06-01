import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card";
import { Separator } from "@/components/ui/separator";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Tooltip,
  TooltipTrigger,
  TooltipContent,
} from "@/components/ui/tooltip";
import { Copy } from "lucide-react";
import type { TreeConfigOptions } from "prolly-wasm";

interface Props {
  treeState: {
    rootHash: string | null;
    treeConfig: TreeConfigOptions | null;
  };
}

export const TreeInfoPanel: React.FC<Props> = ({ treeState }) => {
  const copyHash = () => {
    if (treeState.rootHash) navigator.clipboard.writeText(treeState.rootHash);
  };

  return (
    <Card className="w-full md:max-w-lg mx-auto">
      <CardHeader className="pb-2">
        <div className="flex items-center justify-between">
          <CardTitle className="text-sm font-medium tracking-wide">
            Tree Status
          </CardTitle>

          {treeState.rootHash && (
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-7 w-7"
                  onClick={copyHash}
                >
                  <Copy className="h-4 w-4" />
                </Button>
              </TooltipTrigger>
              <TooltipContent side="left" className="text-xs">
                Copy root hash
              </TooltipContent>
            </Tooltip>
          )}
        </div>

        <Badge
          variant="secondary"
          className="mt-1 font-mono text-xs tracking-tight break-all"
        >
          {treeState.rootHash ?? "N/A (Empty Tree)"}
        </Badge>
      </CardHeader>

      {treeState.treeConfig && (
        <>
          <Separator className="my-2" />

          <CardContent className="grid grid-cols-2 gap-y-1 text-xs">
            {/* Fanout */}
            <span className="text-muted-foreground">Target Fanout</span>
            <span className="font-medium">
              {treeState.treeConfig.targetFanout}
            </span>

            <span className="text-muted-foreground">Min Fanout</span>
            <span className="font-medium">
              {treeState.treeConfig.minFanout}
            </span>

            <span className="text-muted-foreground">Max Inline Value</span>
            <span className="font-medium">
              {treeState.treeConfig.maxInlineValueSize}&nbsp;B
            </span>

            {/* CDC */}
            <span className="col-span-2 text-muted-foreground mt-1">
              Content-Defined Chunking
            </span>

            <span className="text-muted-foreground pl-4">Min</span>
            <span className="font-medium">
              {treeState.treeConfig.cdcMinSize}&nbsp;B
            </span>

            <span className="text-muted-foreground pl-4">Avg</span>
            <span className="font-medium">
              {treeState.treeConfig.cdcAvgSize}&nbsp;B
            </span>

            <span className="text-muted-foreground pl-4">Max</span>
            <span className="font-medium">
              {treeState.treeConfig.cdcMaxSize}&nbsp;B
            </span>
          </CardContent>
        </>
      )}
    </Card>
  );
};

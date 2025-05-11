// src/components/treeOperations/OperationSection.tsx
import React from "react";

interface OperationSectionProps {
  title: string;
  children: React.ReactNode;
  defaultOpen?: boolean;
}

export const OperationSection: React.FC<OperationSectionProps> = ({
  title,
  children,
  defaultOpen = false,
}) => {
  return (
    <details className="space-y-3 group border-t pt-4" open={defaultOpen}>
      <summary className="text-lg font-semibold cursor-pointer group-open:mb-3 list-none flex justify-between items-center">
        {title}
        <span className="text-sm text-muted-foreground group-open:rotate-90 transform transition-transform duration-200">
          &#9656;
        </span>
      </summary>
      <div className="pl-4 border-l-2 border-muted space-y-4 pb-2">
        {children}
      </div>
    </details>
  );
};

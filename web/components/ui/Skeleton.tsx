import React from 'react';

export function Skeleton({
  className,
  ...props
}: React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={`animate-pulse rounded-[4px] bg-[color-mix(in_srgb,var(--text-muted)_18%,transparent)] ${className}`}
      {...props}
    />
  );
}

export function TableSkeleton({ rows = 5, columns = 5 }) {
  return (
    <div className="w-full space-y-3">
      <div className="flex w-full justify-between space-x-4 border-b pb-3 border-[var(--line-grid)]">
        {Array.from({ length: columns }).map((_, i) => (
          <Skeleton key={`h-${i}`} className="h-4 w-[100px] bg-[var(--bg-panel-raised)]" />
        ))}
      </div>
      {Array.from({ length: rows }).map((_, i) => (
        <div key={`r-${i}`} className="flex w-full justify-between space-x-4">
          {Array.from({ length: columns }).map((_, j) => (
            <Skeleton key={`c-${i}-${j}`} className="h-6 w-[100px] bg-[color-mix(in_srgb,var(--text-muted)_18%,transparent)]" />
          ))}
        </div>
      ))}
    </div>
  );
}
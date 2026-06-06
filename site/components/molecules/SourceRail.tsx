import { StatusDot } from "@/components/atoms/StatusDot";
import { TelemetryLabel } from "@/components/atoms/TelemetryLabel";

type SourceRailItem = {
  label: string;
  value: string;
  tone?: "core" | "strong" | "warn" | "fault";
};

type SourceRailProps = {
  items: SourceRailItem[];
};

export function SourceRail({ items }: SourceRailProps) {
  return (
    <div className="grid grid-cols-1 gap-x-6 gap-y-3 border-t border-grid pt-4 sm:grid-cols-2">
      {items.map((item) => (
        <div key={item.label} className="flex min-w-0 items-center justify-between gap-3">
          <TelemetryLabel>{item.label}</TelemetryLabel>
          <span className="flex items-center gap-2 font-mono text-[11px] uppercase tracking-[0.16em] text-secondary whitespace-nowrap shrink-0">
            {item.tone ? <StatusDot tone={item.tone} /> : null}
            {item.value}
          </span>
        </div>
      ))}
    </div>
  );
}

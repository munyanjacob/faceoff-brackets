import { cn } from "@/lib/utils";
import type { BracketStatus, MatchupStatus } from "@/services";

const styles: Record<string, string> = {
  DRAFT: "bg-muted text-muted-foreground",
  SCHEDULED: "bg-accent/15 text-accent",
  ACTIVE: "bg-primary/15 text-primary",
  COMPLETED: "bg-success/15 text-success",
  PENDING: "bg-muted text-muted-foreground",
  TIE_BREAKER: "bg-destructive/15 text-destructive",
};

const labels: Record<string, string> = {
  DRAFT: "Draft",
  SCHEDULED: "Scheduled",
  ACTIVE: "Live",
  COMPLETED: "Finished",
  PENDING: "Not open",
  TIE_BREAKER: "Tie-breaker",
};

export function StatusPill({
  status,
  className,
}: {
  status: BracketStatus | MatchupStatus;
  className?: string;
}) {
  return (
    <span
      className={cn(
        "inline-flex items-center rounded-full px-3 py-1 text-[0.7rem] font-bold uppercase tracking-[0.14em]",
        styles[status] ?? styles["DRAFT"],
        className,
      )}
    >
      {labels[status] ?? status}
    </span>
  );
}

import { useEffect, useState } from "react";

function format(ms: number): string {
  if (ms <= 0) return "Time's up";
  const total = Math.floor(ms / 1000);
  const days = Math.floor(total / 86400);
  const hours = Math.floor((total % 86400) / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  const pad = (n: number) => String(n).padStart(2, "0");
  if (days > 0) return `${days}d ${pad(hours)}:${pad(minutes)}:${pad(seconds)}`;
  return `${pad(hours)}:${pad(minutes)}:${pad(seconds)}`;
}

/** Ticks locally every second against a fixed end timestamp — never polls. */
export function Countdown({ endsAt, className }: { endsAt: string | null; className?: string }) {
  const [remaining, setRemaining] = useState(() =>
    endsAt ? Date.parse(endsAt) - Date.now() : 0,
  );

  useEffect(() => {
    if (!endsAt) return;
    setRemaining(Date.parse(endsAt) - Date.now());
    const id = window.setInterval(() => setRemaining(Date.parse(endsAt) - Date.now()), 1000);
    return () => window.clearInterval(id);
  }, [endsAt]);

  if (!endsAt) return <span className={className}>Not scheduled</span>;
  return (
    <span className={className} suppressHydrationWarning>
      {format(remaining)}
    </span>
  );
}

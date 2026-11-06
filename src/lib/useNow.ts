import { useEffect, useState } from "react";

/** Re-renders on an interval so relative timestamps stay current. */
export function useNow(intervalMs = 15_000): number {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), intervalMs);
    return () => window.clearInterval(timer);
  }, [intervalMs]);
  return now;
}

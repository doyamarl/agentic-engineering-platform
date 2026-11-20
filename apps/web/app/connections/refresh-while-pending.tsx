"use client";

import { useRouter } from "next/navigation";
import { useEffect } from "react";

// The worker exchanges the code and revokes tokens in the background (ADR-013), so a connection
// stays "connecting" or "disconnecting" for a moment. Reads the page again until it settles, for
// at most a minute; after that a reload shows the outcome.

const POLL_MS = 1000;
const GIVE_UP_MS = 60_000;

export function RefreshWhilePending({ pending }: { readonly pending: boolean }) {
  const router = useRouter();
  useEffect(() => {
    if (!pending) return;
    const started = Date.now();
    const timer = setInterval(() => {
      if (Date.now() - started > GIVE_UP_MS) clearInterval(timer);
      else router.refresh();
    }, POLL_MS);
    return () => {
      clearInterval(timer);
    };
  }, [pending, router]);
  return null;
}

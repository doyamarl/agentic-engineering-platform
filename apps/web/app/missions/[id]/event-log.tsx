"use client";

import type { MissionEventDto } from "@aep/contracts";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";

const POLL_MS = 3000;

/** The mission's events, polled every few seconds; new events refresh the rest of the page. */
export function EventLog({
  missionId,
  initial,
}: {
  readonly missionId: string;
  readonly initial: readonly MissionEventDto[];
}) {
  const router = useRouter();
  const [events, setEvents] = useState(initial);
  const last = useRef(initial.at(-1)?.seq ?? 0);

  useEffect(() => {
    let stopped = false;
    const timer = setInterval(() => {
      void fetch(`/missions/${missionId}/events?after=${String(last.current)}`, {
        cache: "no-store",
      })
        .then((r) => (r.ok ? (r.json() as Promise<{ items: MissionEventDto[] }>) : undefined))
        .then((body) => {
          if (stopped || body === undefined || body.items.length === 0) return;
          last.current = body.items.at(-1)?.seq ?? last.current;
          setEvents((current) => [...current, ...body.items]);
          router.refresh();
        })
        .catch(() => undefined);
    }, POLL_MS);
    return () => {
      stopped = true;
      clearInterval(timer);
    };
  }, [missionId, router]);

  return (
    <ol className="events" aria-live="polite">
      {events.map((e) => (
        <li key={e.seq}>
          <time dateTime={e.occurredAt}>{new Date(e.occurredAt).toLocaleString("ja-JP")}</time>{" "}
          <strong>{e.type}</strong> <span className="muted">{e.actor.kind}</span>
          {Object.keys(e.payload).length === 0 ? null : (
            <code className="payload">{JSON.stringify(e.payload)}</code>
          )}
        </li>
      ))}
    </ol>
  );
}

"use client";

import { useCallback, useEffect, useState } from "react";

import { USE_MOCK } from "@/lib/data/mock";
import { getQueue, type QueueEntry } from "@/lib/data/queue";
import type { AppError, Result } from "@/lib/data/types";
import { createClient } from "@/lib/supabase/client";

/**
 * Today's OPD queue. Against the real backend this subscribes to `visits`
 * changes rather than polling (rules.md §6.1); Realtime respects RLS, so a
 * subscription only ever delivers this tenant's rows.
 */
export function useQueue() {
  const [entries, setEntries] = useState<QueueEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<AppError | null>(null);
  /**
   * When the current rows were read. Wait times are derived from this rather
   * than `Date.now()` at render time, which keeps rendering pure and makes the
   * displayed figure honest: "as of the last read".
   */
  const [fetchedAt, setFetchedAt] = useState(0);

  const apply = useCallback((result: Result<QueueEntry[]>) => {
    if (result.error) {
      setError(result.error);
    } else {
      setEntries(result.data ?? []);
      setError(null);
    }
    setFetchedAt(Date.now());
    setLoading(false);
  }, []);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    apply(await getQueue());
  }, [apply]);

  useEffect(() => {
    let active = true;
    void getQueue().then((result) => {
      if (active) apply(result);
    });
    return () => {
      active = false;
    };
  }, [apply]);

  useEffect(() => {
    if (USE_MOCK) return;
    const supabase = createClient();
    const channel = supabase
      .channel("opd-queue")
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "visits" },
        () => {
          // A nurse recording vitals also touches `visits.last_vitals_at`, so an
          // event does not imply the queue state moved (opd-queue.md §10).
          // Re-read rather than inferring anything from the event itself.
          void getQueue().then(apply);
        },
      )
      .subscribe();

    return () => {
      void supabase.removeChannel(channel);
    };
  }, [apply]);

  return { entries, loading, error, refresh, fetchedAt };
}

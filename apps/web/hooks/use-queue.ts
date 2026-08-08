"use client";

import { useCallback, useEffect, useState } from "react";

import { getQueue, type QueueEntry } from "@/lib/data/queue";
import type { AppError, Result } from "@/lib/data/types";

/**
 * Loads the OPD queue. Currently a one-shot fetch against the mock; at
 * integration this hook will own a Supabase Realtime subscription so the list
 * stays live. The returned shape stays the same across that swap.
 */
export function useQueue() {
  const [entries, setEntries] = useState<QueueEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<AppError | null>(null);

  const apply = useCallback((result: Result<QueueEntry[]>) => {
    if (result.error) setError(result.error);
    else setEntries(result.data ?? []);
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

  return { entries, loading, error, refresh };
}

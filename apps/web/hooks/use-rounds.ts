"use client";

import { useCallback, useEffect, useState } from "react";

import { USE_MOCK } from "@/lib/data/mock";
import { getRounds, type RoundsRow } from "@/lib/data/rounds";
import type { AppError, Result } from "@/lib/data/types";
import { createClient } from "@/lib/supabase/client";

/**
 * The inpatient rounds list.
 *
 * Subscribes to both `visits` and `vitals`. A nurse's vitals entry fires a `visits`
 * change too, because the freshness trigger writes `last_vitals_at` — that is what
 * turns an observation into a push on the doctor's open screen with no separate
 * fetch step. Re-read rather than inferring anything from the event.
 */
export function useRounds() {
  const [rows, setRows] = useState<RoundsRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<AppError | null>(null);
  const [fetchedAt, setFetchedAt] = useState(0);

  const apply = useCallback((result: Result<RoundsRow[]>) => {
    if (result.error) {
      setError(result.error);
    } else {
      setRows(result.data ?? []);
      setError(null);
    }
    setFetchedAt(Date.now());
    setLoading(false);
  }, []);

  const refresh = useCallback(async () => {
    apply(await getRounds());
  }, [apply]);

  useEffect(() => {
    let active = true;
    void getRounds().then((result) => {
      if (active) apply(result);
    });
    return () => {
      active = false;
    };
  }, [apply]);

  useEffect(() => {
    if (USE_MOCK) return;
    const supabase = createClient();
    const reread = () => {
      void getRounds().then(apply);
    };
    const channel = supabase
      .channel("rounds")
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "visits" },
        reread,
      )
      .on(
        "postgres_changes",
        { event: "INSERT", schema: "public", table: "vitals" },
        reread,
      )
      .subscribe();

    return () => {
      void supabase.removeChannel(channel);
    };
  }, [apply]);

  return { rows, loading, error, refresh, fetchedAt };
}

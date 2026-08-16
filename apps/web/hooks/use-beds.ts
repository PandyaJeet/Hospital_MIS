"use client";

import { useCallback, useEffect, useState } from "react";

import {
  getCurrentTier,
  listBeds,
  listWards,
  type Bed,
  type Ward,
} from "@/lib/data/beds";
import { USE_MOCK } from "@/lib/data/mock";
import type { AppError, Result } from "@/lib/data/types";
import { createClient } from "@/lib/supabase/client";

interface BoardSnapshot {
  beds: Result<Bed[]>;
  wards: Result<Ward[]>;
  tier: Result<number | null>;
}

function fetchBoard(): Promise<BoardSnapshot> {
  return Promise.all([listBeds(), listWards(), getCurrentTier()]).then(
    ([beds, wards, tier]) => ({ beds, wards, tier }),
  );
}

/**
 * The ward board: bed inventory, ward pricing, and the clinic's tier.
 *
 * Tier is fetched alongside because a Tier 1 clinic can *read* beds but cannot
 * create one or admit into it (ipd-beds.md §3), and saying so up front is kinder
 * than letting someone fill in a form that will be refused. The gate itself lives in
 * RLS and the RPCs, so a wrong answer here cannot grant anything.
 *
 * `beds` is not in the Realtime publication, so this re-reads on `visits` changes —
 * which is what an admission or discharge elsewhere in the clinic looks like from
 * here.
 */
export function useBeds() {
  const [beds, setBeds] = useState<Bed[]>([]);
  const [wards, setWards] = useState<Ward[]>([]);
  const [tier, setTier] = useState<number | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<AppError | null>(null);

  const apply = useCallback((snapshot: BoardSnapshot) => {
    // The bed list is the screen. A missing ward list only costs pricing detail, and
    // a Tier 1 clinic legitimately has no wards, so neither is promoted to an error.
    if (snapshot.beds.error) {
      setError(snapshot.beds.error);
    } else {
      setBeds(snapshot.beds.data ?? []);
      setError(null);
    }
    setWards(snapshot.wards.data ?? []);
    setTier(snapshot.tier.data ?? null);
    setLoading(false);
  }, []);

  const refresh = useCallback(async () => {
    apply(await fetchBoard());
  }, [apply]);

  useEffect(() => {
    let active = true;
    void fetchBoard().then((snapshot) => {
      if (active) apply(snapshot);
    });
    return () => {
      active = false;
    };
  }, [apply]);

  useEffect(() => {
    if (USE_MOCK) return;
    const supabase = createClient();
    const channel = supabase
      .channel("ward-board")
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "visits" },
        () => {
          void fetchBoard().then(apply);
        },
      )
      .subscribe();

    return () => {
      void supabase.removeChannel(channel);
    };
  }, [apply]);

  /** A null tier means "not in a clinic", which is not Tier 1 (ipd-beds.md §3). */
  const ipdEnabled = tier !== null && tier >= 2;

  return { beds, wards, tier, ipdEnabled, loading, error, refresh };
}

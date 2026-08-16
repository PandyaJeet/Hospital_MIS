"use client";

import { useCallback, useEffect, useState } from "react";

import {
  listCriticalAlerts,
  listLabOrders,
  type CriticalAlert,
  type LabOrder,
} from "@/lib/data/labs";
import { USE_MOCK } from "@/lib/data/mock";
import type { AppError, Result } from "@/lib/data/types";
import { createClient } from "@/lib/supabase/client";

interface LabSnapshot {
  orders: Result<LabOrder[]>;
  alerts: Result<CriticalAlert[]>;
}

function fetchLabs(visitId?: string): Promise<LabSnapshot> {
  return Promise.all([listLabOrders(visitId), listCriticalAlerts()]).then(
    ([orders, alerts]) => ({ orders, alerts }),
  );
}

/**
 * Lab orders plus the outstanding critical alerts.
 *
 * Both live here because they move together: recording a result completes an order
 * and may raise an alert in the same call, so refreshing one without the other shows
 * a contradictory screen.
 *
 * `lab_orders` and `lab_results` are both published, so an order raised by another
 * doctor or a result entered at the bench arrives without polling.
 */
export function useLabs(visitId?: string) {
  const [orders, setOrders] = useState<LabOrder[]>([]);
  const [alerts, setAlerts] = useState<CriticalAlert[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<AppError | null>(null);

  const apply = useCallback((snapshot: LabSnapshot) => {
    if (snapshot.orders.error) {
      setError(snapshot.orders.error);
    } else {
      setOrders(snapshot.orders.data ?? []);
      setError(null);
    }
    // Billing cannot read `lab_results` at all (lab-orders.md §4), so an empty or
    // failed alert read is expected for them and must not blank the orders list.
    setAlerts(snapshot.alerts.data ?? []);
    setLoading(false);
  }, []);

  const refresh = useCallback(async () => {
    apply(await fetchLabs(visitId));
  }, [apply, visitId]);

  useEffect(() => {
    let active = true;
    void fetchLabs(visitId).then((snapshot) => {
      if (active) apply(snapshot);
    });
    return () => {
      active = false;
    };
  }, [apply, visitId]);

  useEffect(() => {
    if (USE_MOCK) return;
    const supabase = createClient();
    const reread = () => {
      void fetchLabs(visitId).then(apply);
    };
    const channel = supabase
      .channel("labs")
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "lab_orders" },
        reread,
      )
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "lab_results" },
        reread,
      )
      .subscribe();

    return () => {
      void supabase.removeChannel(channel);
    };
  }, [apply, visitId]);

  return { orders, alerts, loading, error, refresh };
}

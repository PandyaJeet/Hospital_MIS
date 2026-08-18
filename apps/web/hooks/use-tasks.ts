"use client";

import { useCallback, useEffect, useState } from "react";

import { USE_MOCK } from "@/lib/data/mock";
import { getPendingTasks, type Task } from "@/lib/data/tasks";
import type { AppError, Result } from "@/lib/data/types";
import { createClient } from "@/lib/supabase/client";

/**
 * The pending task board. Subscribes to `tasks` rather than polling: auto-created
 * and auto-completed cards arrive through the same channel, which is how a card
 * appears seconds after a doctor orders a lab test with nobody telling the nurse
 * (nurse-tasks.md §8). RLS applies per subscriber, so billing receives nothing.
 */
export function useTasks() {
  const [tasks, setTasks] = useState<Task[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<AppError | null>(null);
  /** When the rows were read — overdue is derived from this, keeping render pure. */
  const [fetchedAt, setFetchedAt] = useState(0);

  const apply = useCallback((result: Result<Task[]>) => {
    if (result.error) {
      setError(result.error);
    } else {
      setTasks(result.data ?? []);
      setError(null);
    }
    setFetchedAt(Date.now());
    setLoading(false);
  }, []);

  const refresh = useCallback(async () => {
    apply(await getPendingTasks());
  }, [apply]);

  useEffect(() => {
    let active = true;
    void getPendingTasks().then((result) => {
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
      .channel("task-board")
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "tasks" },
        () => {
          void getPendingTasks().then(apply);
        },
      )
      .subscribe();

    return () => {
      void supabase.removeChannel(channel);
    };
  }, [apply]);

  return { tasks, loading, error, refresh, fetchedAt };
}

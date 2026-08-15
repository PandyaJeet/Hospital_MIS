import { createClient } from "@/lib/supabase/client";

import { USE_MOCK } from "./mock";
import { fromRpc, mapPostgrestError } from "./rpc";
import type { Result } from "./types";

/**
 * Shapes follow `docs/contracts/nurse-tasks.md`.
 *
 * Two things that shape this UI:
 *  - There is **no scheduler**. Tasks carry a flat `due_at`; "vitals every 4 hours"
 *    does not exist and must not be faked client-side by minting tasks on a timer (§2).
 *  - `status` is not client-writable — completing and cancelling go through RPCs (§4).
 *    Overdue is computed at read time, never stored (§3).
 */
export type TaskType =
  | "vitals_due"
  | "medication_due"
  | "sample_collection_due"
  | "custom";

export type TaskStatus = "pending" | "done" | "cancelled";

export interface Task {
  id: string;
  visit_id: string;
  task_type: TaskType;
  /** Required only for `custom` — every other type is self-describing (§1). */
  title: string | null;
  status: TaskStatus;
  due_at: string;
  /** NULL means unclaimed, which is the normal state on a shared ward board. */
  assigned_to: string | null;
  notes: string | null;
  is_auto: boolean;
}

export function isOverdue(task: Task, now: number) {
  return new Date(task.due_at).getTime() < now;
}

const TASK_SELECT =
  "id, visit_id, task_type, title, status, due_at, assigned_to, notes, is_auto";

/* -------------------------------------------------------------------------- */
/* Real implementation                                                        */
/* -------------------------------------------------------------------------- */

async function realGetPendingTasks(): Promise<Result<Task[]>> {
  const supabase = createClient();
  const { data, error } = await supabase
    .from("tasks")
    .select(TASK_SELECT)
    .eq("status", "pending")
    .order("due_at", { ascending: true });

  if (error) return { data: null, error: mapPostgrestError(error) };
  return { data: (data ?? []) as unknown as Task[], error: null };
}

export interface TaskActionPayload {
  status: TaskStatus;
  changed?: boolean;
  task_type?: TaskType;
}

async function realComplete(
  taskId: string,
  notes?: string,
): Promise<Result<TaskActionPayload>> {
  const supabase = createClient();
  return fromRpc<TaskActionPayload>(
    await supabase.rpc("complete_task", {
      p_task_id: taskId,
      p_notes: notes ?? undefined,
    }),
  );
}

async function realCancel(
  taskId: string,
  reason?: string,
): Promise<Result<TaskActionPayload>> {
  const supabase = createClient();
  return fromRpc<TaskActionPayload>(
    await supabase.rpc("cancel_task", {
      p_task_id: taskId,
      p_reason: reason ?? undefined,
    }),
  );
}

/** Claiming is a plain update — one of the few lifecycle fields clients may write. */
async function realClaim(
  taskId: string,
  userId: string,
): Promise<Result<null>> {
  const supabase = createClient();
  const { error } = await supabase
    .from("tasks")
    .update({ assigned_to: userId })
    .eq("id", taskId);
  if (error) return { data: null, error: mapPostgrestError(error) };
  return { data: null, error: null };
}

/* -------------------------------------------------------------------------- */
/* Mock implementation                                                        */
/* -------------------------------------------------------------------------- */

function minutesFromNow(minutes: number) {
  return new Date(Date.now() + minutes * 60_000).toISOString();
}

let mockTasks: Task[] | null = null;

function seed(): Task[] {
  return [
    {
      id: "t1",
      visit_id: "v1",
      task_type: "vitals_due",
      title: "Baseline vitals on admission",
      status: "pending",
      due_at: minutesFromNow(-45),
      assigned_to: null,
      notes: null,
      is_auto: true,
    },
    {
      id: "t2",
      visit_id: "v3",
      task_type: "sample_collection_due",
      title: "Collect sample — CBC (URGENT)",
      status: "pending",
      due_at: minutesFromNow(-10),
      assigned_to: null,
      notes: null,
      is_auto: true,
    },
    {
      id: "t3",
      visit_id: "v2",
      task_type: "custom",
      title: "Change dressing — bed 4",
      status: "pending",
      due_at: minutesFromNow(25),
      assigned_to: "mock-user-1",
      notes: null,
      is_auto: false,
    },
    {
      id: "t4",
      visit_id: "v1",
      task_type: "medication_due",
      title: null,
      status: "pending",
      due_at: minutesFromNow(90),
      assigned_to: null,
      notes: null,
      is_auto: false,
    },
  ];
}

function delay(ms = 350) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/* -------------------------------------------------------------------------- */
/* Public API                                                                 */
/* -------------------------------------------------------------------------- */

export async function getPendingTasks(): Promise<Result<Task[]>> {
  if (!USE_MOCK) return realGetPendingTasks();
  await delay();
  mockTasks ??= seed();
  return {
    data: mockTasks
      .filter((t) => t.status === "pending")
      .sort((a, b) => a.due_at.localeCompare(b.due_at)),
    error: null,
  };
}

export async function completeTask(
  taskId: string,
  notes?: string,
): Promise<Result<TaskActionPayload>> {
  if (!USE_MOCK) return realComplete(taskId, notes);
  await delay(250);
  mockTasks ??= seed();
  const task = mockTasks.find((t) => t.id === taskId);
  if (!task) {
    return {
      data: null,
      error: { code: "TASK_NOT_FOUND", message: "That task was not found." },
    };
  }
  if (task.status === "done") {
    return {
      data: null,
      error: {
        code: "TASK_ALREADY_DONE",
        message: "That task is already done.",
      },
    };
  }
  if (task.status === "cancelled") {
    return {
      data: null,
      error: { code: "TASK_CANCELLED", message: "That task was cancelled." },
    };
  }
  task.status = "done";
  return {
    data: { status: "done", task_type: task.task_type },
    error: null,
  };
}

export async function cancelTask(
  taskId: string,
  reason?: string,
): Promise<Result<TaskActionPayload>> {
  if (!USE_MOCK) return realCancel(taskId, reason);
  await delay(250);
  mockTasks ??= seed();
  const task = mockTasks.find((t) => t.id === taskId);
  if (!task) {
    return {
      data: null,
      error: { code: "TASK_NOT_FOUND", message: "That task was not found." },
    };
  }
  if (task.status === "done") {
    return {
      data: null,
      error: {
        code: "TASK_ALREADY_DONE",
        message: "That task is already done.",
      },
    };
  }
  // Cancelling an already-cancelled task is an idempotent success.
  const changed = task.status !== "cancelled";
  task.status = "cancelled";
  return { data: { status: "cancelled", changed }, error: null };
}

export async function claimTask(
  taskId: string,
  userId: string,
): Promise<Result<null>> {
  if (!USE_MOCK) return realClaim(taskId, userId);
  await delay(200);
  mockTasks ??= seed();
  const task = mockTasks.find((t) => t.id === taskId);
  if (task) task.assigned_to = userId;
  return { data: null, error: null };
}

/**
 * Mirrors the server-side trigger: recording vitals closes the **oldest pending
 * `vitals_due` card for that visit** (§5). Real mode needs nothing here — the
 * database does it, which is why callers must re-read after a vitals save rather
 * than assuming a card they are showing is still pending.
 */
export function autoCompleteMockVitalsTask(visitId: string) {
  if (!USE_MOCK || !mockTasks) return;
  const oldest = mockTasks
    .filter(
      (t) =>
        t.status === "pending" &&
        t.task_type === "vitals_due" &&
        t.visit_id === visitId,
    )
    .sort((a, b) => a.due_at.localeCompare(b.due_at))[0];
  if (oldest) oldest.status = "done";
}

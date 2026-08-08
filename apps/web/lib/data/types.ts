/**
 * Shared types for the data-access layer (lib/data).
 *
 * Every data function returns { data, error } so callers handle failure
 * explicitly (rules.md §3). The error shape matches the contract format in
 * Workflow.md §1.
 */
export interface AppError {
  /** Stable machine code, e.g. "DUPLICATE_PATIENT", "VALIDATION_ERROR". */
  code: string;
  /** Plain-language, user-safe message — never raw Postgres text (rules.md §3.3). */
  message: string;
  /** Optional field names a validation error applies to. */
  fields?: string[];
}

export interface Result<T> {
  data: T | null;
  error: AppError | null;
}

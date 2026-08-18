/**
 * Database types are generated from the live schema by `npm run db:types`
 * (run from the repo root) and live at `supabase/types/database.types.ts`.
 * Re-exported here so app code imports them from one place.
 *
 * Never hand-write table types (rules.md §5.3) — regenerate instead.
 *
 * ⚠️ The generated file currently predates the Phase 4–6 migrations (Memory.md
 * §1: `supabase gen types` needs Docker, which is unavailable on the dev
 * machine). Tables added in those phases are therefore not represented yet.
 */
export type {
  Database,
  Json,
  Tables,
  TablesInsert,
  TablesUpdate,
  Enums,
} from "../../../../supabase/types/database.types";

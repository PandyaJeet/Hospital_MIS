/**
 * Supabase database types — PLACEHOLDER.
 *
 * This is intentionally an empty schema. Replace it with generated types once
 * the backend schema exists (per rules.md §5.3, do not hand-write table types):
 *
 *   supabase gen types typescript --project-id <project-ref> > lib/supabase/types.ts
 *
 * The empty shape below only exists so the browser/server clients can be typed
 * with a `Database` generic until real types are generated.
 */
export type Json =
  | string
  | number
  | boolean
  | null
  | { [key: string]: Json | undefined }
  | Json[];

export type Database = {
  public: {
    Tables: { [_ in never]: never };
    Views: { [_ in never]: never };
    Functions: { [_ in never]: never };
    Enums: { [_ in never]: never };
    CompositeTypes: { [_ in never]: never };
  };
};

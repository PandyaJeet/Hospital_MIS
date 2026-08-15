-- ============================================================================
-- Migration:  fix_billing_invoice_fk_set_null
-- Purpose:    Repair a Phase 2 foreign key whose ON DELETE action could never
--             fire. Found during Phase 3 closeout by running `db:seed:reset` a
--             second time against a populated project.
--
-- ---------------------------------------------------------------------------
-- THE DEFECT
-- ---------------------------------------------------------------------------
-- 20260811060700 attached billing_line_items to invoices like this, with a
-- comment stating the intent plainly:
--
--     foreign key (invoice_id, tenant_id)
--     references public.invoices (id, tenant_id)
--     on delete set null;
--
--     "ON DELETE SET NULL is safe here because invoice_id is nullable — a
--      deleted draft invoice releases its lines back to 'pending' rather than
--      destroying the charges."
--
-- The intent is right and the mechanism does not deliver it. On a COMPOSITE
-- foreign key, bare `ON DELETE SET NULL` nulls EVERY referencing column — so it
-- tries to null `tenant_id` as well, and `tenant_id` is NOT NULL. Deleting any
-- invoice that has lines therefore fails with
--
--     null value in column "tenant_id" of relation "billing_line_items"
--     violates not-null constraint
--
-- The "release the lines back to pending" behaviour has never worked. It is not
-- that it did the wrong thing; the delete simply could not complete.
--
-- THIS IS THE THIRD INSTANCE OF ONE BUG FAMILY IN THIS CODEBASE. Memory.md §6
-- records the first: a Phase 1 `invites` constraint that collided with its own
-- FK's SET NULL action. The Phase 3 migrations avoided the second by choosing
-- RESTRICT for every composite FK to `profiles`, with the reasoning written out
-- at each site ("SET NULL on a composite FK would try to null the NOT NULL
-- tenant_id and fail at delete time"). This is the same trap, in the one place
-- Phase 2 reached for SET NULL.
--
-- HOW IT STAYED HIDDEN: the first `db:seed:reset` against a fresh project has no
-- invoices to delete, and `verify:remote` always resets BEFORE the suite that
-- creates them. Only a second reset — after a remote run had produced invoices —
-- reaches it. Precisely the lesson already recorded in Memory.md §6 about the
-- invites bug, which is that idempotent tooling has to be run twice to be tested
-- at all. Worth noting it took a third occurrence for the lesson to actually
-- catch something.
--
-- ---------------------------------------------------------------------------
-- THE FIX: A COLUMN LIST ON THE ACTION
-- ---------------------------------------------------------------------------
-- PostgreSQL 15 added `ON DELETE SET NULL ( column, ... )`, which nulls only the
-- named columns. That expresses exactly what Phase 2 meant:
--
--     on delete set null (invoice_id)
--
-- `invoice_id` is released, `tenant_id` is left alone, and the line returns to
-- pending — the documented behaviour, now actually achievable. The composite FK
-- is retained, so a line still cannot be attached to another tenant's invoice.
--
-- Chosen over the alternative of switching to ON DELETE RESTRICT. RESTRICT would
-- also stop the error, but by removing a capability the schema was designed to
-- have: a draft invoice raised in error could then only be deleted after manually
-- detaching every line, and the charges would be stranded if anyone got that
-- sequence wrong. Preserving the intended semantics is better than narrowing them
-- to make a bug go away.
--
-- Both the hosted project and PGlite run PostgreSQL 17, so the column-list form is
-- available in every environment this project uses.
--
-- SAFE ON EXISTING DATA: this alters only the referential ACTION. No rows are
-- read, rewritten or validated against new predicates, and the (invoice_id,
-- tenant_id) pairs already in place continue to satisfy the recreated constraint.
-- ============================================================================

do $$
begin
  if exists (select 1 from pg_constraint where conname = 'billing_invoice_same_tenant') then
    alter table public.billing_line_items
      drop constraint billing_invoice_same_tenant;
  end if;

  alter table public.billing_line_items
    add constraint billing_invoice_same_tenant
    foreign key (invoice_id, tenant_id)
    references public.invoices (id, tenant_id)
    -- The column list is the entire point of this migration.
    on delete set null (invoice_id);
end
$$;

comment on column public.billing_line_items.invoice_id is
  'NULL means the charge is still pending (not yet on an invoice). Set by create_invoice_for_visit(). If an invoice row is ever deleted, ON DELETE SET NULL (invoice_id) releases its lines back to pending WITHOUT touching tenant_id — the column list is required, because a bare SET NULL on this composite FK would try to null the NOT NULL tenant_id and fail outright (see 20260811071300).';

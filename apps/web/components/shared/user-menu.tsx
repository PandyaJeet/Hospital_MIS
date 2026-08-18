"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { LogOut } from "lucide-react";

import { signOut } from "@/lib/data/auth";
import type { Role } from "@/lib/roles";

/**
 * Account menu: who am I, and how do I get out.
 *
 * Identity arrives as props from the layout (resolved server-side) so the avatar
 * never flashes a placeholder letter before settling.
 */
export function UserMenu({
  role,
  fullName,
}: {
  role: Role;
  fullName: string | null;
}) {
  const t = useTranslations("common");
  const tRoles = useTranslations("roles");
  const router = useRouter();

  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);

  async function handleSignOut() {
    setBusy(true);
    setFailed(false);
    const { error } = await signOut();
    if (error) {
      // Do not navigate on failure. proxy.ts bounces an authenticated user off
      // /login back to their home, so a blind redirect here would look like the
      // button silently did nothing.
      setBusy(false);
      setFailed(true);
      return;
    }
    // replace(), not push() — the signed-in screens should not be one Back away.
    router.replace("/login");
    // Discard cached Server Component output belonging to the old session.
    router.refresh();
  }

  const initial = (fullName?.trim()?.[0] ?? role[0]).toUpperCase();

  return (
    <div
      className="relative"
      onKeyDown={(event) => {
        if (event.key === "Escape") setOpen(false);
      }}
    >
      <button
        type="button"
        aria-label={t("account")}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
        className="flex h-8 w-8 items-center justify-center rounded-full bg-accent-subtle text-sm font-medium text-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-surface"
      >
        {initial}
      </button>

      {open ? (
        <>
          {/* Click-anywhere-else to dismiss, without a document listener. */}
          <button
            type="button"
            aria-label={t("closeMenu")}
            tabIndex={-1}
            onClick={() => setOpen(false)}
            className="fixed inset-0 z-40 cursor-default"
          />
          <div
            role="menu"
            aria-label={t("account")}
            className="absolute right-0 top-10 z-50 w-60 overflow-hidden rounded-md border border-border bg-surface shadow-lg"
          >
            <div className="border-b border-border px-3 py-2.5">
              <p className="truncate text-sm font-medium text-text-primary">
                {fullName ?? "\u2014"}
              </p>
              <p className="text-xs text-text-secondary">{tRoles(role)}</p>
            </div>

            {failed ? (
              <p className="px-3 pt-2 text-xs text-warning">
                {t("signOutFailed")}
              </p>
            ) : null}

            <div className="p-1">
              <button
                type="button"
                role="menuitem"
                onClick={handleSignOut}
                disabled={busy}
                className="flex w-full items-center gap-2 rounded px-2 py-2 text-sm font-medium text-text-primary transition-colors hover:bg-surface-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent disabled:cursor-not-allowed disabled:opacity-50"
              >
                <LogOut className="h-4 w-4 shrink-0" aria-hidden="true" />
                {t("signOut")}
              </button>
            </div>
          </div>
        </>
      ) : null}
    </div>
  );
}

"use client";

import { useState, type ReactNode } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useTranslations } from "next-intl";
import { Activity, Menu, Search, X } from "lucide-react";

import { LanguageSwitcher } from "@/components/shared/language-switcher";
import { roleNav, type Role } from "@/lib/navigation";
import { cn } from "@/lib/utils/cn";

function Brand({ role }: { role: Role }) {
  const t = useTranslations("roles");
  return (
    <div className="flex h-14 items-center gap-2 border-b border-border px-4">
      <Activity className="h-5 w-5 shrink-0 text-accent" aria-hidden="true" />
      <div className="flex flex-col leading-tight">
        <span className="text-sm font-semibold text-text-primary">
          Hospital MIS
        </span>
        <span className="text-xs text-text-secondary">{t(role)}</span>
      </div>
    </div>
  );
}

function NavLinks({
  role,
  onNavigate,
}: {
  role: Role;
  onNavigate?: () => void;
}) {
  const pathname = usePathname();
  const t = useTranslations("nav");

  return (
    <nav className="flex flex-col gap-1 p-3">
      {roleNav[role].map((item) => {
        const active =
          pathname === item.href || pathname.startsWith(`${item.href}/`);
        const Icon = item.icon;
        return (
          <Link
            key={item.href}
            href={item.href}
            onClick={onNavigate}
            aria-current={active ? "page" : undefined}
            className={cn(
              "flex items-center gap-3 rounded-md px-3 py-2 text-sm font-medium transition-colors",
              active
                ? "bg-accent-subtle text-accent"
                : "text-text-secondary hover:bg-surface-muted hover:text-text-primary",
            )}
          >
            <Icon className="h-5 w-5 shrink-0" aria-hidden="true" />
            {t(item.key)}
          </Link>
        );
      })}
    </nav>
  );
}

export function AppShell({
  role,
  children,
}: {
  role: Role;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const t = useTranslations("common");

  return (
    <div className="flex flex-1">
      {/* Desktop sidebar */}
      <aside className="hidden w-60 shrink-0 flex-col border-r border-border bg-surface md:flex">
        <Brand role={role} />
        <NavLinks role={role} />
      </aside>

      {/* Mobile drawer */}
      {open ? (
        <div className="fixed inset-0 z-40 md:hidden">
          <button
            type="button"
            aria-label={t("closeMenu")}
            onClick={() => setOpen(false)}
            className="absolute inset-0 bg-black/40"
          />
          <aside className="absolute inset-y-0 left-0 flex w-64 flex-col bg-surface shadow-xl">
            <button
              type="button"
              aria-label={t("closeMenu")}
              onClick={() => setOpen(false)}
              className="absolute right-2 top-3 z-10 rounded-md p-2 text-text-secondary hover:bg-surface-muted"
            >
              <X className="h-5 w-5" aria-hidden="true" />
            </button>
            <Brand role={role} />
            <NavLinks role={role} onNavigate={() => setOpen(false)} />
          </aside>
        </div>
      ) : null}

      {/* Content column */}
      <div className="flex min-w-0 flex-1 flex-col">
        <header className="flex h-14 items-center gap-3 border-b border-border bg-surface px-4">
          <button
            type="button"
            aria-label={t("openMenu")}
            onClick={() => setOpen(true)}
            className="rounded-md p-2 text-text-secondary hover:bg-surface-muted md:hidden"
          >
            <Menu className="h-5 w-5" aria-hidden="true" />
          </button>

          <div className="relative hidden max-w-md flex-1 sm:block">
            <Search
              className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-text-disabled"
              aria-hidden="true"
            />
            <input
              type="search"
              aria-label={t("search")}
              placeholder={t("search")}
              className="h-9 w-full rounded-md border border-border bg-background pl-9 pr-3 text-sm text-text-primary placeholder:text-text-disabled focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
            />
          </div>

          <div className="ml-auto flex items-center gap-2">
            <LanguageSwitcher />
            <button
              type="button"
              aria-label={t("account")}
              className="flex h-8 w-8 items-center justify-center rounded-full bg-accent-subtle text-sm font-medium text-accent"
            >
              P
            </button>
          </div>
        </header>

        {children}
      </div>
    </div>
  );
}

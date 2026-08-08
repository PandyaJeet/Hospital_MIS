"use client";

import { useRouter } from "next/navigation";
import { useLocale, useTranslations } from "next-intl";

import { setLocale } from "@/lib/i18n/actions";
import { localeShortLabels, locales, type Locale } from "@/lib/i18n/config";
import { cn } from "@/lib/utils/cn";

export function LanguageSwitcher() {
  const router = useRouter();
  const active = useLocale();
  const t = useTranslations("common");

  function selectLocale(locale: Locale) {
    if (locale === active) return;
    void setLocale(locale).then(() => router.refresh());
  }

  return (
    <div
      role="group"
      aria-label={t("language")}
      className="flex items-center gap-0.5 rounded-md border border-border p-0.5"
    >
      {locales.map((locale) => {
        const isActive = locale === active;
        return (
          <button
            key={locale}
            type="button"
            onClick={() => selectLocale(locale)}
            aria-pressed={isActive}
            className={cn(
              "rounded px-2 py-1 text-xs font-medium transition-colors",
              isActive
                ? "bg-accent-subtle text-accent"
                : "text-text-secondary hover:text-text-primary",
            )}
          >
            {localeShortLabels[locale]}
          </button>
        );
      })}
    </div>
  );
}

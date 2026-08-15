export const locales = ["en", "hi", "gu"] as const;

export type Locale = (typeof locales)[number];

export const defaultLocale: Locale = "en";

/** Full names (for menus). */
export const localeLabels: Record<Locale, string> = {
  en: "English",
  hi: "हिन्दी",
  gu: "ગુજરાતી",
};

/** Compact labels for the top-bar switcher. */
export const localeShortLabels: Record<Locale, string> = {
  en: "EN",
  hi: "हि",
  gu: "ગુ",
};

export const LOCALE_COOKIE = "NEXT_LOCALE";

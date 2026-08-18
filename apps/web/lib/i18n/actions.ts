"use server";

import { cookies } from "next/headers";

import { LOCALE_COOKIE, locales, type Locale } from "./config";

/**
 * Persist the chosen locale in the NEXT_LOCALE cookie. The client calls this,
 * then refreshes so getRequestConfig picks up the new locale on re-render.
 */
export async function setLocale(locale: Locale) {
  if (!locales.includes(locale)) return;
  const store = await cookies();
  store.set(LOCALE_COOKIE, locale, {
    path: "/",
    maxAge: 60 * 60 * 24 * 365,
    sameSite: "lax",
  });
}

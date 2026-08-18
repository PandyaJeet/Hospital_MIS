import { cookies } from "next/headers";
import { getRequestConfig } from "next-intl/server";

import { defaultLocale, LOCALE_COOKIE, locales, type Locale } from "./config";

/**
 * No i18n routing: the active locale comes from the NEXT_LOCALE cookie (set by
 * the language switcher), not the URL. See next-intl "without i18n routing".
 */
export default getRequestConfig(async () => {
  const store = await cookies();
  const cookieLocale = store.get(LOCALE_COOKIE)?.value;
  const locale: Locale = locales.includes(cookieLocale as Locale)
    ? (cookieLocale as Locale)
    : defaultLocale;

  return {
    locale,
    messages: (await import(`../../messages/${locale}.json`)).default,
  };
});

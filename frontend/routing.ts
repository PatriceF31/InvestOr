import { defineRouting } from "next-intl/routing";
export const routing = defineRouting({
  locales: ["fr", "pt"],
  defaultLocale: "fr",
  localeDetection: false,
  localeCookie: {
    name: "NEXT_LOCALE",
    sameSite: "lax",
  },
});

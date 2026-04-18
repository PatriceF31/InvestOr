import createNextIntlPlugin from "next-intl/plugin";
const withNextIntl = createNextIntlPlugin("./i18n.ts");

const withPWA = (await import("next-pwa")).default({
  dest: "public",
  disable: process.env.NODE_ENV === "development",
});

const nextConfig = { reactStrictMode: true };

export default withPWA(withNextIntl(nextConfig));
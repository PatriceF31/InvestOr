import type { GetStaticPropsContext } from "next";
import { useTranslations } from "next-intl";

export default function HomePage() {
  const t = useTranslations("dashboard");

  return (
    <main className="min-h-screen flex items-center justify-center">
      <div className="text-center space-y-4">
        <h1 className="text-4xl font-bold text-primary">InvestOr</h1>
        <p className="text-muted-foreground">{t("title")}</p>
        <p className="text-sm text-muted-foreground">Setup OK ✓</p>
      </div>
    </main>
  );
}

export async function getStaticProps({ locale }: GetStaticPropsContext) {
  const safeLocale = locale ?? "fr";
  const messages = (await import(`@/messages/${safeLocale}.json`)).default;
  return {
    props: { locale: safeLocale, messages },
  };
}

export async function getStaticPaths() {
  return {
    paths: [{ params: { locale: "fr" } }, { params: { locale: "pt" } }],
    fallback: false,
  };
}

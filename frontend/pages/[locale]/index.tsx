import type { GetStaticPropsContext } from "next";
import { useTranslations } from "next-intl";
import { useAccount } from "wagmi";
import { useEffect, useState } from "react";

export default function DashboardPage() {
  const t = useTranslations("dashboard");
  const { address, isConnected } = useAccount();
  const [mounted, setMounted] = useState(false);

  useEffect(() => { setMounted(true); }, []);

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-3xl font-bold">{t("title")}</h1>
        <p className="text-muted-foreground mt-1">
          {mounted && isConnected
            ? `${address?.slice(0, 6)}...${address?.slice(-4)}`
            : "Connectez votre portefeuille pour commencer"
          }
        </p>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
        {[
          { label: t("balance_gld"), value: "— GLD", sub: "0.000 g" },
          { label: t("balance_usdc"), value: "— USDC", sub: "Treasury" },
          { label: t("gold_price"), value: "—", sub: t("per_gram") },
          { label: t("reserve_ratio"), value: "—", sub: t("healthy") },
        ].map((card) => (
          <div
            key={card.label}
            className="rounded-lg border border-border bg-card p-6 space-y-2"
          >
            <p className="text-sm text-muted-foreground">{card.label}</p>
            <p className="text-2xl font-bold text-primary">{card.value}</p>
            <p className="text-xs text-muted-foreground">{card.sub}</p>
          </div>
        ))}
      </div>
    </div>
  );
}

export async function getStaticProps({ locale }: GetStaticPropsContext) {
  const safeLocale = locale ?? "fr";
  const messages = (await import(`@/messages/${safeLocale}.json`)).default;
  return { props: { locale: safeLocale, messages } };
}

export async function getStaticPaths() {
  return {
    paths: [{ params: { locale: "fr" } }, { params: { locale: "pt" } }],
    fallback: false,
  };
}

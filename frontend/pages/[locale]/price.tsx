import type { GetStaticPropsContext } from "next";
import { useState, useEffect, useCallback } from "react";
import { useTranslations } from "next-intl";
import { useReadContract } from "wagmi";
import { useContracts } from "@/hooks/useContracts";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Separator } from "@/components/ui/separator";
import { TrendingUp, RefreshCw, Zap, Globe } from "lucide-react";
import useSWR from "swr";

// ── Constantes ────────────────────────────────────────────────────────────────
const TROY_OZ_TO_GRAM = 31.1035;
const GOLD_API_URL    = "https://www.goldapi.io/api/XAU/USD";

// ── Fetcher Gold API ──────────────────────────────────────────────────────────
const fetcher = async (url: string) => {
  const apiKey = process.env.NEXT_PUBLIC_GOLD_API_KEY;
  if (!apiKey || apiKey === "demo") return null;
  const res = await fetch(url, {
    headers: { "x-access-token": apiKey, "Content-Type": "application/json" },
  });
  if (!res.ok) return null;
  return res.json();
};

// ── Card prix ─────────────────────────────────────────────────────────────────
function PriceCard({
  label, value, sub, badge, badgeVariant = "default", icon: Icon,
}: {
  label: string; value: string; sub?: string;
  badge?: string; badgeVariant?: "default" | "secondary" | "outline";
  icon: any;
}) {
  return (
    <div className="rounded-xl border border-border bg-card p-6 space-y-3">
      <div className="flex items-center justify-between">
        <span className="text-sm text-muted-foreground">{label}</span>
        <div className="p-2 rounded-lg bg-primary/10">
          <Icon className="h-4 w-4 text-primary" />
        </div>
      </div>
      <p className="text-3xl font-bold text-primary">{value}</p>
      {sub && <p className="text-xs text-muted-foreground">{sub}</p>}
      {badge && <Badge variant={badgeVariant} className="text-xs">{badge}</Badge>}
    </div>
  );
}

export default function PricePage() {
  const t = useTranslations("price");
  const { exchange } = useContracts();
  const [mounted, setMounted] = useState(false);
  const [lastUpdate, setLastUpdate] = useState<Date | null>(null);
  useEffect(() => { setMounted(true); }, []);

  // ── Prix on-chain (Chainlink via Exchange) ────────────────────────────────
  const { data: priceRaw, refetch, isLoading } = useReadContract({
    ...exchange,
    functionName: "getPrice",
    query: { refetchInterval: 60_000 },
  });
  const priceData   = priceRaw as [bigint, boolean] | undefined;
  const onChainPrice = priceData?.[0];
  const isOracle    = priceData?.[1] ?? false;

  // ── Prix API REST (goldapi.io) ─────────────────────────────────────────────
  const { data: apiData, mutate: refreshApi } = useSWR(GOLD_API_URL, fetcher, {
    refreshInterval: 300_000, // toutes les 5 min
    onSuccess: () => setLastUpdate(new Date()),
  });

  const handleRefresh = useCallback(() => {
    refetch();
    refreshApi();
    setLastUpdate(new Date());
  }, [refetch, refreshApi]);

  // Calculs
  // getPrice() retourne toujours en $/gramme (8 décimales)
  // Exchange.sol travaille en $/gramme nativement
  const onChainPerGram = onChainPrice !== undefined
    ? Number(onChainPrice) / 1e8 : null;
  const onChainPerOz = onChainPerGram !== null
    ? onChainPerGram * TROY_OZ_TO_GRAM : null;

  const apiPerOz   = apiData?.price    ?? null;
  const apiPerGram = apiPerOz !== null ? apiPerOz / TROY_OZ_TO_GRAM : null;

  // Spread entre les deux sources
  const spread = onChainPerGram !== null && apiPerGram !== null
    ? Math.abs(onChainPerGram - apiPerGram) : null;
  const spreadPct = spread !== null && apiPerGram !== null
    ? ((spread / apiPerGram) * 100).toFixed(2) : null;

  if (!mounted) return null;

  return (
    <div className="max-w-2xl mx-auto space-y-6">

      {/* En-tête */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <TrendingUp className="h-7 w-7 text-primary" />
          <div>
            <h1 className="text-3xl font-bold">{t("title")}</h1>
            <p className="text-muted-foreground text-sm">
              XAU/USD — {t("gold_in_gram")}
            </p>
          </div>
        </div>
        <Button variant="outline" size="sm" onClick={handleRefresh} disabled={isLoading}>
          <RefreshCw className={`h-4 w-4 mr-2 ${isLoading ? "animate-spin" : ""}`} />
          {t("refresh")}
        </Button>
      </div>

      {/* Prix on-chain */}
      <div>
        <div className="flex items-center gap-2 mb-3">
          <Zap className="h-4 w-4 text-primary" />
          <h2 className="font-semibold">{t("source_oracle")}</h2>
          <Badge variant={isOracle ? "default" : "secondary"} className="text-xs">
            {isOracle ? "Chainlink live" : "Fallback"}
          </Badge>
        </div>
        <div className="grid grid-cols-2 gap-4">
          <PriceCard
            icon={TrendingUp}
            label={t("per_gram")}
            value={onChainPerGram !== null ? `$${onChainPerGram.toFixed(2)}` : "—"}
            sub={`1 GLD = 1 ${t("gram")}`}
            badge="XAU/USD"
          />
          <PriceCard
            icon={TrendingUp}
            label={t("per_oz")}
            value={onChainPerOz !== null ? `$${onChainPerOz.toFixed(2)}` : "—"}
            sub={`1 ${t("oz")} troy = 31.1035 g`}
            badge="XAU/USD"
          />
        </div>
      </div>

      <Separator />

      {/* Prix API REST */}
      <div>
        <div className="flex items-center gap-2 mb-3">
          <Globe className="h-4 w-4 text-muted-foreground" />
          <h2 className="font-semibold">{t("source_api")}</h2>
          <Badge variant="outline" className="text-xs">goldapi.io</Badge>
          {process.env.NEXT_PUBLIC_GOLD_API_KEY === "demo" && (
            <Badge variant="secondary" className="text-xs">Clé demo — configurez NEXT_PUBLIC_GOLD_API_KEY</Badge>
          )}
        </div>
        <div className="grid grid-cols-2 gap-4">
          <PriceCard
            icon={Globe}
            label={t("per_gram")}
            value={apiPerGram !== null ? `$${apiPerGram.toFixed(2)}` : "—"}
            sub="Marché spot"
            badge="REST API"
            badgeVariant="secondary"
          />
          <PriceCard
            icon={Globe}
            label={t("per_oz")}
            value={apiPerOz !== null ? `$${apiPerOz.toFixed(2)}` : "—"}
            sub="Marché spot"
            badge="REST API"
            badgeVariant="secondary"
          />
        </div>
      </div>

      {/* Spread */}
      {spread !== null && (
        <>
          <Separator />
          <div className="rounded-lg border border-border bg-card/50 p-4 flex items-center justify-between">
            <div>
              <p className="text-sm font-medium">Écart Oracle / API</p>
              <p className="text-xs text-muted-foreground">
                Différence entre Chainlink et goldapi.io
              </p>
            </div>
            <div className="text-right">
              <p className="text-lg font-bold">${spread.toFixed(4)}</p>
              <p className="text-xs text-muted-foreground">{spreadPct}%</p>
            </div>
          </div>
        </>
      )}

      {/* Dernière mise à jour */}
      {lastUpdate && (
        <p className="text-center text-xs text-muted-foreground">
          {t("last_update")} : {lastUpdate.toLocaleTimeString("fr-FR")}
        </p>
      )}

      {/* Note */}
      <div className="rounded-lg bg-muted/30 p-4 text-xs text-muted-foreground space-y-1">
        <p>• Le prix on-chain provient de l'oracle Chainlink configuré dans Exchange.sol.</p>
        <p>• Le prix API provient de goldapi.io (clé gratuite disponible sur goldapi.io).</p>
        <p>• En cas d'indisponibilité de l'oracle, un prix fallback défini par l'owner est utilisé.</p>
      </div>
    </div>
  );
}

export async function getStaticProps({ params }: GetStaticPropsContext) {
  const safeLocale = (params?.locale as string) ?? "fr";
  const messages = (await import(`@/messages/${safeLocale}.json`)).default;
  return { props: { locale: safeLocale, messages } };
}
export async function getStaticPaths() {
  return {
    paths: [{ params: { locale: "fr" } }, { params: { locale: "pt" } }],
    fallback: false,
  };
}

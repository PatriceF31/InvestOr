import type { GetStaticPropsContext } from "next";
import { useTranslations } from "next-intl";
import { useAccount } from "wagmi";
import { useEffect, useState } from "react";
import { useDashboard } from "@/hooks/useDashboard";
import { Badge } from "@/components/ui/badge";
import { Separator } from "@/components/ui/separator";
import { RefreshCw, TrendingUp, Wallet, Shield, Coins } from "lucide-react";
import { Button } from "@/components/ui/button";

// ── Carte de statistique ──────────────────────────────────────────────────────
function StatCard({
  icon: Icon,
  label,
  value,
  sub,
  badge,
  badgeVariant = "default",
}: {
  icon: any;
  label: string;
  value: string;
  sub?: string;
  badge?: string;
  badgeVariant?: "default" | "destructive" | "secondary" | "outline";
}) {
  return (
    <div className="rounded-xl border border-border bg-card p-6 space-y-3 hover:border-primary/50 transition-colors">
      <div className="flex items-center justify-between">
        <span className="text-sm text-muted-foreground">{label}</span>
        <div className="p-2 rounded-lg bg-primary/10">
          <Icon className="h-4 w-4 text-primary" />
        </div>
      </div>
      <div className="space-y-1">
        <p className="text-2xl font-bold text-foreground">{value}</p>
        {sub && <p className="text-xs text-muted-foreground">{sub}</p>}
      </div>
      {badge && (
        <Badge variant={badgeVariant} className="text-xs">
          {badge}
        </Badge>
      )}
    </div>
  );
}

// ── Page principale ───────────────────────────────────────────────────────────
export default function DashboardPage() {
  const t = useTranslations("dashboard");
  const { address, isConnected } = useAccount();
  const [mounted, setMounted] = useState(false);
  const { formatted, reserve, isOracle, isLoading, refetch } = useDashboard();

  useEffect(() => { setMounted(true); }, []);

  if (!mounted) return null;

  return (
    <div className="space-y-8">

      {/* En-tête */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-3xl font-bold">{t("title")}</h1>
          <p className="text-muted-foreground mt-1 text-sm">
            {isConnected
              ? `${address?.slice(0, 6)}...${address?.slice(-4)}`
              : "Connectez votre portefeuille pour voir vos données"
            }
          </p>
        </div>
        {isConnected && (
          <Button variant="outline" size="sm" onClick={() => refetch()} disabled={isLoading}>
            <RefreshCw className={`h-4 w-4 mr-2 ${isLoading ? "animate-spin" : ""}`} />
            Rafraîchir
          </Button>
        )}
      </div>

      {/* Bannière Exchange pausé */}
      {reserve.exchangePaused && (
        <div className="rounded-lg border border-destructive/50 bg-destructive/10 p-4 text-sm text-destructive">
          ⚠️ L'Exchange est actuellement pausé — les achats et ventes sont temporairement suspendus.
        </div>
      )}

      {/* Cards principales */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
        <StatCard
          icon={Coins}
          label={t("balance_gld")}
          value={`${formatted.gldBalance} GLD`}
          sub={`≈ ${formatted.gldBalance !== "—" ? `${parseFloat(formatted.gldBalance).toFixed(3)} g` : "—"} d'or`}
        />
        <StatCard
          icon={Wallet}
          label={t("balance_usdc")}
          value={`${formatted.usdcBalance} USDC`}
          sub="Déposé dans Treasury"
        />
        <StatCard
          icon={TrendingUp}
          label={t("gold_price")}
          value={formatted.pricePerGram}
          sub={formatted.pricePerOz + " / once"}
          badge={isOracle ? "Chainlink" : "Fallback"}
          badgeVariant={isOracle ? "default" : "secondary"}
        />
        <StatCard
          icon={Shield}
          label={t("reserve_ratio")}
          value={reserve.ratioPercent === "∞" || reserve.ratioPercent === "—" ? reserve.ratioPercent : `${reserve.ratioPercent}`}
          sub={`Min : ${reserve.minRatioBps !== undefined ? (Number(reserve.minRatioBps) / 100).toFixed(0) : "—"}%`}
          badge={reserve.healthy ? t("healthy") : t("at_risk")}
          badgeVariant={reserve.healthy ? "default" : "destructive"}
        />
      </div>

      <Separator />

      {/* Stats globales */}
      <div>
        <h2 className="text-lg font-semibold mb-4">Statistiques globales</h2>
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
          <div className="rounded-lg border border-border bg-card/50 p-4 space-y-1">
            <p className="text-xs text-muted-foreground">GLD en circulation</p>
            <p className="text-lg font-semibold">{formatted.gldSupply} GLD</p>
            <p className="text-xs text-muted-foreground">{Number(formatted.gldSupply !== "—" ? formatted.gldSupply : 0).toFixed(3)} grammes tokenisés</p>
          </div>
          <div className="rounded-lg border border-border bg-card/50 p-4 space-y-1">
            <p className="text-xs text-muted-foreground">USDC en réserve</p>
            <p className="text-lg font-semibold">{formatted.usdcTotal} USDC</p>
            <p className="text-xs text-muted-foreground">Total déposé dans Treasury</p>
          </div>
          <div className="rounded-lg border border-border bg-card/50 p-4 space-y-1">
            <p className="text-xs text-muted-foreground">Valeur or (USDC)</p>
            <p className="text-lg font-semibold">
              {reserve.goldValueUsdc !== undefined
                ? `${parseFloat((Number(reserve.goldValueUsdc) / 1e6).toFixed(2))} USDC`
                : "—"
              }
            </p>
            <p className="text-xs text-muted-foreground">Valeur marchande des GLD</p>
          </div>
        </div>
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

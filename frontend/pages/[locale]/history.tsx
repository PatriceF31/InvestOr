import type { GetStaticPropsContext } from "next";
import { useState, useEffect } from "react";
import { useTranslations } from "next-intl";
import { useAccount, useReadContract } from "wagmi";
import { formatUnits } from "viem";
import { useContracts } from "@/hooks/useContracts";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { RefreshCw, History, ArrowDownToLine, ArrowUpFromLine, TrendingUp, TrendingDown, Coins, Flame } from "lucide-react";

const ACTION_LABELS: Record<number, { label: string; icon: any; color: string }> = {
  0: { label: "Dépôt",    icon: ArrowDownToLine, color: "text-blue-500" },
  1: { label: "Retrait",  icon: ArrowUpFromLine, color: "text-orange-500" },
  2: { label: "Achat",    icon: TrendingUp,      color: "text-green-500" },
  3: { label: "Vente",    icon: TrendingDown,    color: "text-red-500" },
  4: { label: "Mint",     icon: Coins,           color: "text-primary" },
  5: { label: "Burn",     icon: Flame,           color: "text-orange-600" },
  6: { label: "Blacklist",icon: History,         color: "text-gray-500" },
  7: { label: "Urgence",  icon: History,         color: "text-destructive" },
};

type LogEntry = {
  timestamp: bigint;
  user: `0x${string}`;
  action: number;
  amount: bigint;
  price: bigint;
  source: `0x${string}`;
};

function EntryRow({ entry }: { entry: LogEntry }) {
  const action   = ACTION_LABELS[entry.action] ?? ACTION_LABELS[0];
  const Icon     = action.icon;
  const date     = new Date(Number(entry.timestamp) * 1000);
  const isUSDC   = entry.action === 0 || entry.action === 1 || entry.action === 3;
  const decimals = isUSDC ? 6 : 3;
  const symbol   = isUSDC ? "USDC" : "GLD";

  return (
    <div className="flex items-center gap-4 py-3 border-b border-border last:border-0">
      <div className={`p-2 rounded-lg bg-muted ${action.color}`}>
        <Icon className="h-4 w-4" />
      </div>
      <div className="flex-1 min-w-0">
        <p className="font-medium text-sm">{action.label}</p>
        <p className="text-xs text-muted-foreground truncate">
          {entry.user.slice(0, 6)}...{entry.user.slice(-4)}
        </p>
      </div>
      <div className="text-right">
        <p className="font-semibold text-sm">
          {formatUnits(entry.amount, decimals)} {symbol}
        </p>
        {entry.price > 0n && (
          <p className="text-xs text-muted-foreground">
            ${(Number(entry.price) / 1e8).toFixed(2)}/g
          </p>
        )}
      </div>
      <div className="text-right text-xs text-muted-foreground min-w-[80px]">
        <p>{date.toLocaleDateString("fr-FR")}</p>
        <p>{date.toLocaleTimeString("fr-FR", { hour: "2-digit", minute: "2-digit" })}</p>
      </div>
    </div>
  );
}

export default function HistoryPage() {
  const t = useTranslations("history");
  const { address } = useAccount();
  const { eventLogger } = useContracts();
  const [mounted, setMounted] = useState(false);
  useEffect(() => { setMounted(true); }, []);

  // 20 dernières entrées globales
  const { data: recentRaw, refetch, isLoading } = useReadContract({
    ...eventLogger,
    functionName: "getRecentEntries",
    args: [20n],
    query: { refetchInterval: 30_000 },
  });

  // Entrées de l'utilisateur connecté
  const { data: userRaw } = useReadContract({
    ...eventLogger,
    functionName: "getUserEntries",
    args: address ? [address, 0n, 20n] : undefined,
    query: { enabled: !!address, refetchInterval: 30_000 },
  });

  const recentEntries = (recentRaw as LogEntry[] | undefined) ?? [];
  const userEntries   = (userRaw   as LogEntry[] | undefined) ?? [];

  if (!mounted) return null;

  return (
    <div className="max-w-2xl mx-auto space-y-6">

      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <History className="h-7 w-7 text-primary" />
          <div>
            <h1 className="text-3xl font-bold">{t("title")}</h1>
            <p className="text-muted-foreground text-sm">Toutes les opérations on-chain</p>
          </div>
        </div>
        <Button variant="outline" size="sm" onClick={() => refetch()} disabled={isLoading}>
          <RefreshCw className={`h-4 w-4 mr-2 ${isLoading ? "animate-spin" : ""}`} />
          Rafraîchir
        </Button>
      </div>

      <Tabs defaultValue="recent">
        <TabsList className="w-full">
          <TabsTrigger value="recent" className="flex-1">Récentes</TabsTrigger>
          <TabsTrigger value="mine"   className="flex-1">Mes opérations</TabsTrigger>
        </TabsList>

        <TabsContent value="recent">
          <div className="rounded-xl border border-border bg-card p-4">
            {isLoading ? (
              <div className="flex items-center justify-center py-8">
                <RefreshCw className="h-6 w-6 animate-spin text-muted-foreground" />
              </div>
            ) : recentEntries.length === 0 ? (
              <div className="text-center py-8 text-muted-foreground">
                <History className="h-8 w-8 mx-auto mb-2 opacity-50" />
                <p>{t("no_history")}</p>
              </div>
            ) : (
              [...recentEntries].reverse().map((entry, i) => (
                <EntryRow key={i} entry={entry} />
              ))
            )}
          </div>
        </TabsContent>

        <TabsContent value="mine">
          <div className="rounded-xl border border-border bg-card p-4">
            {!address ? (
              <div className="text-center py-8 text-muted-foreground">
                <p>Connectez votre portefeuille</p>
              </div>
            ) : userEntries.length === 0 ? (
              <div className="text-center py-8 text-muted-foreground">
                <History className="h-8 w-8 mx-auto mb-2 opacity-50" />
                <p>{t("no_history")}</p>
              </div>
            ) : (
              [...userEntries].reverse().map((entry, i) => (
                <EntryRow key={i} entry={entry} />
              ))
            )}
          </div>
        </TabsContent>
      </Tabs>

      {/* Légende */}
      <div className="rounded-lg border border-border bg-card/50 p-4">
        <p className="text-xs font-medium text-muted-foreground mb-3 uppercase tracking-wide">Légende</p>
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
          {Object.entries(ACTION_LABELS).map(([key, val]) => {
            const Icon = val.icon;
            return (
              <div key={key} className="flex items-center gap-2 text-xs">
                <Icon className={`h-3 w-3 ${val.color}`} />
                <span className="text-muted-foreground">{val.label}</span>
              </div>
            );
          })}
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

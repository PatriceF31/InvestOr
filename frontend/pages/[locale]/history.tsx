import type { GetStaticPropsContext } from "next";
import { useState, useEffect } from "react";
import { useTranslations } from "next-intl";
import { useAccount, usePublicClient } from "wagmi";
import { createPublicClient, http } from "viem";
import { sepolia } from "wagmi/chains";
import { formatUnits } from "viem";
import { useContracts } from "@/hooks/useContracts";
import { Button } from "@/components/ui/button";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { RefreshCw, History, ArrowDownToLine, ArrowUpFromLine, TrendingUp, TrendingDown } from "lucide-react";
import { ExchangeABI, TreasuryABI } from "@/lib/abis";

// ── Types ─────────────────────────────────────────────────────────────────────
type LogEntry = {
  type: "BUY" | "SELL" | "DEPOSIT" | "WITHDRAWAL";
  address: string;
  amount: bigint;
  price?: bigint;
  txHash: string;
  blockNumber: bigint;
  timestamp?: number;
};

// ── Composant ligne ───────────────────────────────────────────────────────────
function EntryRow({ entry, config }: { 
  entry: LogEntry; 
  config: Record<string, { label: string; icon: React.ComponentType<{ className?: string }>; color: string; bg: string }> 
}) {
  const cfg = config[entry.type];
  const Icon = cfg.icon as React.FC<{ className?: string }>;
  const isUSDC = entry.type === "DEPOSIT" || entry.type === "WITHDRAWAL";
  const decimals = isUSDC ? 6 : 3;
  const symbol   = isUSDC ? "USDC" : "GLD";

  return (
    <div className="flex items-center gap-4 py-3 border-b border-border last:border-0">
    <div className={`p-2 rounded-lg ${cfg.bg} ${cfg.color} shrink-0`}>
        <Icon className="h-4 w-4" />
      </div>
      <div className="flex-1 min-w-0">
        <p className="font-medium text-sm">{cfg.label}</p>
        <p className="text-xs text-muted-foreground font-mono truncate">
          {entry.address.slice(0, 6)}...{entry.address.slice(-4)}
        </p>
      </div>
      <div className="text-right">
        <p className="font-semibold text-sm">
          {formatUnits(entry.amount, decimals)} {symbol}
        </p>
        {entry.price !== undefined && entry.price > 0n && (
          <p className="text-xs text-muted-foreground">
            ${(Number(entry.price) / 1e8).toFixed(2)}/g
          </p>
        )}
      </div>
      <div className="text-right text-xs text-muted-foreground min-w-[90px]">
        {entry.timestamp ? (
          <>
            <p>{new Date(entry.timestamp * 1000).toLocaleDateString("fr-FR")}</p>
            <p>{new Date(entry.timestamp * 1000).toLocaleTimeString("fr-FR", { hour: "2-digit", minute: "2-digit" })}</p>
          </>
        ) : (
          <p>Bloc {entry.blockNumber.toString()}</p>
        )}
        <a
          href={`https://sepolia.etherscan.io/tx/${entry.txHash}`}
          target="_blank"
          rel="noopener noreferrer"
          className="text-primary hover:underline"
        >
          Etherscan ↗
        </a>
      </div>
    </div>
  );
}

// ── Page principale ───────────────────────────────────────────────────────────
export default function HistoryPage() {
  const t = useTranslations("history");
  const { address } = useAccount();
  const { exchange, treasury } = useContracts();
  const client = usePublicClient();
  // Client dédié avec RPC public pour getLogs (Alchemy free = 10 blocs max)
  const publicClient = createPublicClient({
    chain: sepolia,
    transport: http("https://ethereum-sepolia-rpc.publicnode.com"),
  });
  const [mounted, setMounted] = useState(false);
  const [entries, setEntries] = useState<LogEntry[]>([]);
  const [isLoading, setIsLoading] = useState(false);

  const ACTION_CONFIG = {
    BUY:        { label: t("buy"),      icon: TrendingUp,      color: "text-green-500",  bg: "bg-green-500/10" },
    SELL:       { label: t("sell"),     icon: TrendingDown,    color: "text-red-500",    bg: "bg-red-500/10" },
    DEPOSIT:    { label: t("deposit"),  icon: ArrowDownToLine, color: "text-blue-500",   bg: "bg-blue-500/10" },
    WITHDRAWAL: { label: t("withdraw"), icon: ArrowUpFromLine, color: "text-orange-500", bg: "bg-orange-500/10" },
  };

  useEffect(() => { setMounted(true); }, []);

  const fetchLogs = async () => {
    if (!client) return;
    setIsLoading(true);
    try {
      // Utiliser RPC public pour getLogs (Alchemy free = 10 blocs max)
      const latestBlock = await publicClient.getBlockNumber();
      const fromBlock = latestBlock > 50000n ? latestBlock - 50000n : 0n;

      // Récupérer les logs TokensBought
      const buyLogs = await publicClient.getLogs({
        address: exchange.address,
        event: ExchangeABI.find((x: any) => x.name === "TokensBought") as any,
        fromBlock,
      });

      // Récupérer les logs TokensSold
      const sellLogs = await publicClient.getLogs({
        address: exchange.address,
        event: ExchangeABI.find((x: any) => x.name === "TokensSold") as any,
        fromBlock,
      });

      // Récupérer les logs Deposited
      const depositLogs = await publicClient.getLogs({
        address: treasury.address,
        event: TreasuryABI.find((x: any) => x.name === "Deposited") as any,
        fromBlock,
      });

      // Récupérer les logs Withdrawn
      const withdrawLogs = await publicClient.getLogs({
        address: treasury.address,
        event: TreasuryABI.find((x: any) => x.name === "Withdrawn") as any,
        fromBlock,
      });

      // Récupérer les timestamps des blocs
      const allBlocks = new Set([
        ...buyLogs.map((l: any) => l.blockNumber),
        ...sellLogs.map((l: any) => l.blockNumber),
        ...depositLogs.map((l: any) => l.blockNumber),
        ...withdrawLogs.map((l: any) => l.blockNumber),
      ]);

      const blockTimestamps: Record<string, number> = {};
      await Promise.all(
        [...allBlocks].map(async (bn) => {
          try {
            const block = await publicClient.getBlock({ blockNumber: bn as bigint });
            blockTimestamps[bn!.toString()] = Number(block.timestamp);
          } catch {}
        })
      );

      // Assembler toutes les entrées
      const all: LogEntry[] = [
        ...buyLogs.map((l: any) => ({
          type: "BUY" as const,
          address: l.args.buyer,
          amount: l.args.gldAmount,
          price: l.args.price,
          txHash: l.transactionHash,
          blockNumber: l.blockNumber,
          timestamp: blockTimestamps[l.blockNumber?.toString() ?? ""],
        })),
        ...sellLogs.map((l: any) => ({
          type: "SELL" as const,
          address: l.args.seller,
          amount: l.args.gldAmount,
          price: l.args.price,
          txHash: l.transactionHash,
          blockNumber: l.blockNumber,
          timestamp: blockTimestamps[l.blockNumber?.toString() ?? ""],
        })),
        ...depositLogs.map((l: any) => ({
          type: "DEPOSIT" as const,
          address: l.args.user,
          amount: l.args.amount,
          txHash: l.transactionHash,
          blockNumber: l.blockNumber,
          timestamp: blockTimestamps[l.blockNumber?.toString() ?? ""],
        })),
        ...withdrawLogs.map((l: any) => ({
          type: "WITHDRAWAL" as const,
          address: l.args.user,
          amount: l.args.amount,
          txHash: l.transactionHash,
          blockNumber: l.blockNumber,
          timestamp: blockTimestamps[l.blockNumber?.toString() ?? ""],
        })),
      ];

      // Trier par bloc décroissant
      all.sort((a, b) => Number(b.blockNumber - a.blockNumber));
      setEntries(all);
    } catch (e) {
      console.error("Erreur getLogs:", e);
    } finally {
      setIsLoading(false);
    }
  };

  useEffect(() => {
    if (mounted) fetchLogs();
  }, [mounted, exchange.address, treasury.address]);

  if (!mounted) return null;

  const userEntries = address
    ? entries.filter(e => e.address.toLowerCase() === address.toLowerCase())
    : [];

  const EntriesList = ({ list }: { list: LogEntry[] }) => (
    <div className="rounded-xl border border-border bg-card p-4">
      {isLoading ? (
        <div className="flex items-center justify-center py-8">
          <RefreshCw className="h-6 w-6 animate-spin text-muted-foreground" />
        </div>
      ) : list.length === 0 ? (
        <div className="text-center py-8 text-muted-foreground">
          <History className="h-8 w-8 mx-auto mb-2 opacity-50" />
          <p>{t("no_history")}</p>
        </div>
      ) : (
        list.slice(0, 50).map((entry, i) => <EntryRow key={i} entry={entry} config={ACTION_CONFIG} />)
      )}
    </div>
  );

  return (
    <div className="max-w-2xl mx-auto space-y-6">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <History className="h-7 w-7 text-primary" />
          <div>
            <h1 className="text-3xl font-bold">{t("title")}</h1>
            <p className="text-muted-foreground text-sm">
              {entries.length} opération{entries.length !== 1 ? "s" : ""} trouvée{entries.length !== 1 ? "s" : ""}
            </p>
          </div>
        </div>
        <Button variant="outline" size="sm" onClick={fetchLogs} disabled={isLoading}>
          <RefreshCw className={`h-4 w-4 mr-2 ${isLoading ? "animate-spin" : ""}`} />
          Rafraîchir
        </Button>
      </div>

      <Tabs defaultValue="recent">
        <TabsList className="w-full">
          <TabsTrigger value="recent" className="flex-1">
            Toutes ({entries.length})
          </TabsTrigger>
          <TabsTrigger value="mine" className="flex-1">
            Mes opérations ({userEntries.length})
          </TabsTrigger>
        </TabsList>
        <TabsContent value="recent">
          <EntriesList list={entries} />
        </TabsContent>
        <TabsContent value="mine">
          {!address ? (
            <div className="rounded-xl border border-border bg-card p-8 text-center text-muted-foreground">
              {t("connect_hint")}
            </div>
          ) : (
            <EntriesList list={userEntries} />
          )}
        </TabsContent>
      </Tabs>

      {/* Légende */}
      <div className="rounded-lg border border-border bg-card/50 p-4">
        <p className="text-xs font-medium text-muted-foreground mb-3 uppercase tracking-wide">Légende</p>
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
          {Object.entries(ACTION_CONFIG).map(([key, val]) => {
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

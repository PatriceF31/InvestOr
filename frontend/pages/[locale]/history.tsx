import type { GetStaticPropsContext } from "next";
import { useState, useEffect } from "react";
import { useTranslations } from "next-intl";
import { useAccount } from "wagmi";
import { createPublicClient, http, formatUnits } from "viem";
import { sepolia } from "wagmi/chains";
import { Button } from "@/components/ui/button";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { RefreshCw, History, ArrowDownToLine, ArrowUpFromLine, TrendingUp, TrendingDown } from "lucide-react";
import { EventLoggerABI } from "@/lib/abis";
// ⚠️ Si EventLoggerABI n'est pas encore exporté depuis "@/lib/abis", ajoute-le
// là-bas (même pattern que ExchangeABI/TreasuryABI) à partir du fichier
// EventLoggerABI.json déjà généré.

// ⚠️ Si useContracts() expose déjà eventLogger.address, utilise-le à la place
// de cette constante en dur.
const EVENT_LOGGER_ADDRESS = "0x70eFf6af5aCE213cEe7a3AFC4587db478c4F4b5a" as const;

// ⚠️ Gating UX uniquement — les entrées EventLogger sont publiques on-chain
// (n'importe qui peut les lire via Etherscan ou un script), donc cette liste
// ne "sécurise" rien : elle évite juste d'afficher le contrôle "Toutes" à des
// utilisateurs qui n'en ont pas l'usage. À maintenir en phase avec les
// signataires du Safe InvestOr (0x7f7533Ea6aA203d07eBB6F06aE1a8A4AD0B33917).
const ADMIN_ADDRESSES = (process.env.NEXT_PUBLIC_ADMIN_ADDRESSES ?? "")
  .split(",")
  .map((a) => a.trim().toLowerCase())
  .filter(Boolean);

// Correspondance avec EventLogger.ActionType (cf. EventLogger.sol)
const ACTION_TYPE = { DEPOSIT: 0, WITHDRAWAL: 1, BUY: 2, SELL: 3 } as const;
type ActionKey = "BUY" | "SELL" | "DEPOSIT" | "WITHDRAWAL";
const ACTION_BY_CODE: Record<number, ActionKey> = {
  0: "DEPOSIT",
  1: "WITHDRAWAL",
  2: "BUY",
  3: "SELL",
};

// ── Types ─────────────────────────────────────────────────────────────────────
type LogEntry = {
  type: ActionKey;
  address: string;   // EventLogger.LogEntry.user
  amount: bigint;     // GLD pour BUY/SELL (3 dec), stablecoin pour DEPOSIT/WITHDRAWAL (6 dec)
  price?: bigint;
  source: string;     // contrat émetteur (Exchange ou Treasury)
  txHash: string;
  blockNumber: bigint;
  timestamp: number;  // fourni directement par l'event ActionLogged, pas besoin de getBlock()
};

// ── Composant ligne ───────────────────────────────────────────────────────────
function EntryRow({ entry, config }: {
  entry: LogEntry;
  config: Record<string, { label: string; icon: React.ComponentType<{ className?: string }>; color: string; bg: string }>
}) {
  const cfg = config[entry.type];
  const Icon = cfg.icon as React.FC<{ className?: string }>;
  const isStable = entry.type === "DEPOSIT" || entry.type === "WITHDRAWAL";
  const decimals = isStable ? 6 : 3;
  const symbol = isStable ? "USDC" : "GLD";
  // Note : EventLogger ne distingue pas USDC/EURC (contrairement aux events natifs
  // TokensBought/Deposited) — cette info n'est plus affichable sur cette page
  // depuis qu'on lit EventLogger plutôt que les events natifs d'Exchange/Treasury.

  return (
    <div className="flex items-center gap-4 py-3 border-b border-border last:border-0">
      <div className={`p-2 rounded-lg ${cfg.bg} ${cfg.color} shrink-0`}>
        <Icon className="h-4 w-4" />
      </div>
      <div className="flex-1 min-w-0">
        <p className="font-medium text-sm">{cfg.label}</p>
        <p className="text-xs text-muted-foreground font-mono truncate">
          {(entry.address ?? '').slice(0, 6)}...{(entry.address ?? '').slice(-4)}
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
        <p>{new Date(entry.timestamp * 1000).toLocaleDateString("fr-FR")}</p>
        <p>{new Date(entry.timestamp * 1000).toLocaleTimeString("fr-FR", { hour: "2-digit", minute: "2-digit" })}</p>
        <a
          href={entry.txHash ? `https://sepolia.etherscan.io/tx/${entry.txHash}` : '#'}
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

  // RPC public dédié pour getLogs — conservé du composant original (Alchemy/Infura
  // free tier plafonnent eth_getLogs à 10 000 blocs, ce qui a déjà causé des crashs
  // ailleurs dans ce projet). La fenêtre de 50 000 blocs ci-dessous fonctionne avec
  // ce provider en pratique, mais reste une fenêtre glissante, pas l'historique complet
  // — à paginer en boucle si un jour il faut remonter plus loin.
  const publicClient = createPublicClient({
    chain: sepolia,
    transport: http("https://ethereum-sepolia-rpc.publicnode.com"),
  });

  const [mounted, setMounted] = useState(false);
  const [allEntries, setAllEntries] = useState<LogEntry[]>([]);
  const [myEntries, setMyEntries] = useState<LogEntry[]>([]);
  const [isLoading, setIsLoading] = useState(false);

  const isAdmin = !!address && ADMIN_ADDRESSES.includes(address.toLowerCase());

  const ACTION_CONFIG = {
    BUY:        { label: t("buy"),      icon: TrendingUp,      color: "text-green-500",  bg: "bg-green-500/10" },
    SELL:       { label: t("sell"),     icon: TrendingDown,    color: "text-red-500",    bg: "bg-red-500/10" },
    DEPOSIT:    { label: t("deposit"),  icon: ArrowDownToLine, color: "text-blue-500",   bg: "bg-blue-500/10" },
    WITHDRAWAL: { label: t("withdraw"), icon: ArrowUpFromLine, color: "text-orange-500", bg: "bg-orange-500/10" },
  };

  useEffect(() => { setMounted(true); }, []);

  const actionLoggedEvent = EventLoggerABI.find((x: any) => x.name === "ActionLogged") as any;

  const decodeLogs = (logs: any[]): LogEntry[] =>
    logs
      .filter((l) => ACTION_BY_CODE[Number(l.args.action)] !== undefined)
      .map((l) => ({
        type: ACTION_BY_CODE[Number(l.args.action)],
        address: l.args.user as string,
        amount: l.args.amount as bigint,
        price: l.args.price as bigint,
        source: l.args.source as string,
        txHash: l.transactionHash as string,
        blockNumber: l.blockNumber as bigint,
        timestamp: Number(l.args.timestamp),
      }))
      .sort((a, b) => Number(b.blockNumber - a.blockNumber));

  const getFromBlock = async () => {
    const latestBlock = await publicClient.getBlockNumber();
    return latestBlock > 50_000n ? latestBlock - 50_000n : 0n;
  };

  // Toutes les opérations BUY/SELL — Option 1 : DEPOSIT/WITHDRAWAL masqués côté
  // requête (args.action) car redondants avec BUY/SELL tant que Treasury n'est
  // déclenché que par Exchange. Si Reserve (ou un autre module) devient un jour
  // une source autorisée appelant Treasury.withdraw()/deposit() indépendamment
  // d'Exchange, ce filtre masquera aussi ces mouvements-là — à revoir alors.
  const fetchAll = async () => {
    if (!isAdmin) return;
    setIsLoading(true);
    try {
      const fromBlock = await getFromBlock();
      const logs = await publicClient.getLogs({
        address: EVENT_LOGGER_ADDRESS,
        event: actionLoggedEvent,
        args: { action: [ACTION_TYPE.BUY, ACTION_TYPE.SELL] },
        fromBlock,
      });
      setAllEntries(decodeLogs(logs));
    } catch (e) {
      console.error("Erreur getLogs EventLogger (toutes) :", e);
    } finally {
      setIsLoading(false);
    }
  };

  // Mes opérations — filtré côté RPC par `user`, jamais les données des autres
  // ne transitent par le navigateur pour être filtrées ensuite à l'affichage.
  const fetchMine = async () => {
    if (!address) { setMyEntries([]); return; }
    setIsLoading(true);
    try {
      const fromBlock = await getFromBlock();
      const logs = await publicClient.getLogs({
        address: EVENT_LOGGER_ADDRESS,
        event: actionLoggedEvent,
        args: { user: address, action: [ACTION_TYPE.BUY, ACTION_TYPE.SELL] },
        fromBlock,
      });
      setMyEntries(decodeLogs(logs));
    } catch (e) {
      console.error("Erreur getLogs EventLogger (mine) :", e);
    } finally {
      setIsLoading(false);
    }
  };

  const refresh = () => {
    if (isAdmin) fetchAll();
    fetchMine();
  };

  useEffect(() => {
    if (mounted) refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mounted, address, isAdmin]);

  if (!mounted) return null;

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

  const totalShown = isAdmin ? allEntries.length : myEntries.length;

  return (
    <div className="max-w-2xl mx-auto space-y-6">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <History className="h-7 w-7 text-primary" />
          <div>
            <h1 className="text-3xl font-bold">{t("title")}</h1>
            <p className="text-muted-foreground text-sm">
              {totalShown} {t("operation")}{totalShown !== 1 ? "s" : ""} {t("found")}{totalShown !== 1 ? "s" : ""}
            </p>
          </div>
        </div>
        <Button variant="outline" size="sm" onClick={refresh} disabled={isLoading}>
          <RefreshCw className={`h-4 w-4 mr-2 ${isLoading ? "animate-spin" : ""}`} />
          {t("refresh")}
        </Button>
      </div>

      {isAdmin ? (
        <Tabs defaultValue="recent">
          <TabsList className="w-full">
            <TabsTrigger value="recent" className="flex-1">
              {t("all")} ({allEntries.length})
            </TabsTrigger>
            <TabsTrigger value="mine" className="flex-1">
              {t("mine")} ({myEntries.length})
            </TabsTrigger>
          </TabsList>
          <TabsContent value="recent">
            <EntriesList list={allEntries} />
          </TabsContent>
          <TabsContent value="mine">
            {!address ? (
              <div className="rounded-xl border border-border bg-card p-8 text-center text-muted-foreground">
                {t("connect_hint")}
              </div>
            ) : (
              <EntriesList list={myEntries} />
            )}
          </TabsContent>
        </Tabs>
      ) : !address ? (
        <div className="rounded-xl border border-border bg-card p-8 text-center text-muted-foreground">
          {t("connect_hint")}
        </div>
      ) : (
        <EntriesList list={myEntries} />
      )}

      {/* Légende */}
      <div className="rounded-lg border border-border bg-card/50 p-4">
        <p className="text-xs font-medium text-muted-foreground mb-3 uppercase tracking-wide">{t("legend")}</p>
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

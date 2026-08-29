import type { GetStaticPropsContext } from "next";
import { useState, useEffect, useMemo } from "react";
import { useTranslations } from "next-intl";
import { useAccount } from "wagmi";
import { createPublicClient, http, formatUnits } from "viem";
import { sepolia } from "wagmi/chains";
import { useContracts } from "@/hooks/useContracts";
import { useLombard, type LombardHealth } from "@/hooks/useLombard";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Badge } from "@/components/ui/badge";
import { Separator } from "@/components/ui/separator";
import {
  Landmark, ShieldAlert, ShieldCheck, AlertTriangle, CheckCircle2,
  AlertCircle, Loader2, RefreshCw, History, Gift,
  ArrowDownToLine, ArrowUpFromLine, HandCoins, Undo2,
} from "lucide-react";

// ── Constantes ────────────────────────────────────────────────────────────────
const GLD_DECIMALS = 3;
const USDC_DECIMALS = 6;

// RPC public dédié pour getLogs (mêmes contraintes que history.tsx : plafond
// eth_getLogs des providers gratuits ⇒ fenêtre glissante de 50 000 blocs)
const publicClient = createPublicClient({
  chain: sepolia,
  transport: http("https://ethereum-sepolia-rpc.publicnode.com"),
});

// ── Statut de transaction (même pattern que trade.tsx/reserve.tsx) ────────────
type TxState = "idle" | "pending" | "confirming" | "success" | "error";

function TxStatus({ state, hash, error }: { state: TxState; hash?: `0x${string}`; error?: string }) {
  if (state === "idle") return null;
  return (
    <div className={`rounded-lg p-4 flex items-start gap-3 text-sm ${
      state === "success" ? "bg-green-500/10 border border-green-500/20" :
      state === "error"   ? "bg-destructive/10 border border-destructive/20" :
                            "bg-primary/10 border border-primary/20"
    }`}>
      {(state === "pending" || state === "confirming") &&
        <Loader2 className="h-4 w-4 animate-spin mt-0.5 text-primary shrink-0" />}
      {state === "success" && <CheckCircle2 className="h-4 w-4 mt-0.5 text-green-500 shrink-0" />}
      {state === "error"   && <AlertCircle  className="h-4 w-4 mt-0.5 text-destructive shrink-0" />}
      <div className="space-y-1">
        <p className="font-medium">
          {state === "pending"    && "Confirmez dans votre portefeuille..."}
          {state === "confirming" && "Transaction en cours..."}
          {state === "success"    && "Transaction réussie !"}
          {state === "error"      && "Erreur de transaction"}
        </p>
        {hash && state === "success" && (
          <p className="text-xs text-muted-foreground font-mono">
            {hash.slice(0, 10)}...{hash.slice(-8)}
          </p>
        )}
        {error && state === "error" && (
          <p className="text-xs text-destructive/80 break-words">{error}</p>
        )}
      </div>
    </div>
  );
}

function DetailRow({ label, value, highlight }: { label: string; value: string; highlight?: boolean }) {
  return (
    <div className="flex items-center justify-between text-sm py-1">
      <span className="text-muted-foreground">{label}</span>
      <span className={`font-medium ${highlight ? "text-primary" : ""}`}>{value}</span>
    </div>
  );
}

// Message d'erreur générique — signale l'hypothèse KYC/conformité sans sur-promettre
// (le revert exact dépend de GLD/CountryComplianceModule, non décodé ici)
function friendlyError(e: unknown): string {
  const msg = e instanceof Error ? e.message : String(e);
  if (/reject/i.test(msg)) return "Transaction rejetée dans le portefeuille.";
  if (/insufficient/i.test(msg) && /allowance/i.test(msg)) return "Approbation insuffisante — réessayez.";
  return msg.slice(0, 220) +
    " — si le dépôt de collatéral échoue systématiquement, vérifiez que votre wallet est bien vérifié KYC (IdentityRegistry).";
}

// ── Jauge LTV ─────────────────────────────────────────────────────────────────
function LtvGauge({
  currentLtvBps, ltvMaxBps, liquidationThresholdBps, health,
}: {
  currentLtvBps?: bigint; ltvMaxBps?: bigint; liquidationThresholdBps?: bigint; health: LombardHealth;
}) {
  const pct = (v?: bigint) => v !== undefined ? Math.min(Number(v) / 100, 100) : 0;
  const barColor = health === "danger" ? "bg-destructive"
    : health === "warning" ? "bg-orange-500"
    : "bg-primary";

  return (
    <div className="space-y-2">
      <div className="relative h-3 rounded-full bg-muted overflow-hidden">
        <div className={`absolute inset-y-0 left-0 rounded-full transition-all ${barColor}`}
          style={{ width: `${pct(currentLtvBps)}%` }} />
        {ltvMaxBps !== undefined && (
          <div className="absolute inset-y-0 w-px bg-foreground/40"
            style={{ left: `${pct(ltvMaxBps)}%` }} title="LTV max" />
        )}
        {liquidationThresholdBps !== undefined && (
          <div className="absolute inset-y-0 w-px bg-destructive"
            style={{ left: `${pct(liquidationThresholdBps)}%` }} title="Seuil de liquidation" />
        )}
      </div>
      <div className="flex justify-between text-[11px] text-muted-foreground">
        <span>0%</span>
        <span>LTV max {ltvMaxBps !== undefined ? (Number(ltvMaxBps) / 100).toFixed(0) : "—"}%</span>
        <span>Liquidation {liquidationThresholdBps !== undefined ? (Number(liquidationThresholdBps) / 100).toFixed(0) : "—"}%</span>
      </div>
    </div>
  );
}

function HealthBadge({ health }: { health: LombardHealth }) {
  if (health === "none") return null;
  if (health === "safe") return (
    <Badge className="text-xs"><ShieldCheck className="h-3 w-3 mr-1" />Position saine</Badge>
  );
  if (health === "warning") return (
    <Badge variant="secondary" className="text-xs bg-orange-500/15 text-orange-600 hover:bg-orange-500/15">
      <AlertTriangle className="h-3 w-3 mr-1" />Proche du seuil
    </Badge>
  );
  return (
    <Badge variant="destructive" className="text-xs"><ShieldAlert className="h-3 w-3 mr-1" />Liquidable</Badge>
  );
}

// ── Panneau Emprunteur (US-01) ─────────────────────────────────────────────────
function BorrowPanel() {
  const { address } = useAccount();
  const lombard = useLombard();
  const { params, position, pool, wallet, refetch } = lombard;

  const [collateralInput, setCollateralInput] = useState("");
  const [collateralMode, setCollateralMode] = useState<"deposit" | "withdraw">("deposit");
  const [debtInput, setDebtInput] = useState("");
  const [debtMode, setDebtMode] = useState<"borrow" | "repay">("borrow");

  const [txState, setTxState] = useState<TxState>("idle");
  const [txHash, setTxHash] = useState<`0x${string}` | undefined>();
  const [txError, setTxError] = useState<string | undefined>();

  const isBusy = txState === "pending" || txState === "confirming";

  const runTx = async (fn: () => Promise<`0x${string}`>, onDone: () => void) => {
    try {
      setTxError(undefined);
      setTxState("pending");
      const hash = await fn();
      setTxHash(hash);
      setTxState("success");
      onDone();
      refetch();
    } catch (e) {
      setTxError(friendlyError(e));
      setTxState("error");
    }
  };

  const handleCollateral = () => {
    if (!collateralInput || Number(collateralInput) <= 0) return;
    if (collateralMode === "deposit") {
      runTx(() => lombard.depositCollateral(collateralInput), () => setCollateralInput(""));
    } else {
      runTx(() => lombard.withdrawCollateral(collateralInput), () => setCollateralInput(""));
    }
  };

  const handleDebt = () => {
    if (!debtInput || Number(debtInput) <= 0) return;
    if (debtMode === "borrow") {
      runTx(() => lombard.borrow(debtInput), () => setDebtInput(""));
    } else {
      runTx(() => lombard.repay(debtInput), () => setDebtInput(""));
    }
  };

  return (
    <div className="space-y-6">
      {/* Résumé position */}
      <div className="rounded-xl border border-border bg-card p-5 space-y-4">
        <div className="flex items-center justify-between">
          <h3 className="font-semibold">Votre position</h3>
          <HealthBadge health={position.health} />
        </div>
        <LtvGauge
          currentLtvBps={position.currentLtvBps}
          ltvMaxBps={params.ltvMaxBps}
          liquidationThresholdBps={params.liquidationThresholdBps}
          health={position.health}
        />
        <Separator />
        <DetailRow label="Collatéral déposé" value={`${position.collateralFormatted} GLD`} />
        <DetailRow label="Dette totale (capital + intérêt)" value={`${position.debtFormatted} USDC`} highlight />
        <DetailRow label="LTV actuel" value={position.currentLtvPercent} />
        <DetailRow label="Taux d'emprunt" value={params.borrowRatePercent + "/an"} />
      </div>

      {pool.isPaused && (
        <div className="rounded-lg border border-destructive/50 bg-destructive/10 p-3 text-sm text-destructive flex items-center gap-2">
          <AlertTriangle className="h-4 w-4 shrink-0" /> Le vault est actuellement en pause.
        </div>
      )}

      {/* Collatéral */}
      <div className="rounded-xl border border-border bg-card p-5 space-y-4">
        <div className="flex items-center justify-between">
          <h3 className="font-semibold">Collatéral (GLD)</h3>
          <span className="text-xs text-muted-foreground">Solde : {wallet.gldBalanceFormatted} GLD</span>
        </div>
        <div className="flex rounded-lg border border-border overflow-hidden text-sm">
          {(["deposit", "withdraw"] as const).map((m) => (
            <button key={m} onClick={() => setCollateralMode(m)}
              className={`flex-1 py-2 font-medium transition-colors ${
                collateralMode === m ? "bg-primary text-primary-foreground" : "bg-background text-muted-foreground hover:bg-muted"
              }`}>
              {m === "deposit" ? "Déposer" : "Retirer"}
            </button>
          ))}
        </div>
        <div className="relative">
          <Input type="number" placeholder="0.0" value={collateralInput}
            onChange={(e) => setCollateralInput(e.target.value)}
            className="pr-16" min="0" step="0.001" />
          <span className="absolute right-3 top-1/2 -translate-y-1/2 text-sm text-muted-foreground">GLD</span>
        </div>
        <Button className="w-full" variant={collateralMode === "deposit" ? "default" : "outline"}
          disabled={!address || isBusy || !collateralInput || Number(collateralInput) <= 0}
          onClick={handleCollateral}>
          {isBusy ? <><Loader2 className="h-4 w-4 mr-2 animate-spin" />En cours...</>
            : collateralMode === "deposit"
              ? <><ArrowDownToLine className="h-4 w-4 mr-2" />Déposer le collatéral</>
              : <><ArrowUpFromLine className="h-4 w-4 mr-2" />Retirer le collatéral</>}
        </Button>
      </div>

      {/* Emprunt */}
      <div className="rounded-xl border border-border bg-card p-5 space-y-4">
        <div className="flex items-center justify-between">
          <h3 className="font-semibold">Emprunt (USDC)</h3>
          <span className="text-xs text-muted-foreground">Liquidité dispo : {pool.availableLiquidityFormatted} USDC</span>
        </div>
        <div className="flex rounded-lg border border-border overflow-hidden text-sm">
          {(["borrow", "repay"] as const).map((m) => (
            <button key={m} onClick={() => setDebtMode(m)}
              className={`flex-1 py-2 font-medium transition-colors ${
                debtMode === m ? "bg-primary text-primary-foreground" : "bg-background text-muted-foreground hover:bg-muted"
              }`}>
              {m === "borrow" ? "Emprunter" : "Rembourser"}
            </button>
          ))}
        </div>
        <div className="relative">
          <Input type="number" placeholder="0.0" value={debtInput}
            onChange={(e) => setDebtInput(e.target.value)}
            className="pr-16" min="0" step="0.01" />
          <span className="absolute right-3 top-1/2 -translate-y-1/2 text-sm text-muted-foreground">USDC</span>
        </div>
        {debtMode === "repay" && (
          <Button variant="ghost" size="sm" className="text-xs text-primary p-0 h-auto"
            onClick={() => setDebtInput(position.debtFormatted !== "—" ? position.debtFormatted : "")}>
            Rembourser le total dû
          </Button>
        )}
        <Button className="w-full" variant={debtMode === "borrow" ? "default" : "outline"}
          disabled={!address || isBusy || !debtInput || Number(debtInput) <= 0}
          onClick={handleDebt}>
          {isBusy ? <><Loader2 className="h-4 w-4 mr-2 animate-spin" />En cours...</>
            : debtMode === "borrow"
              ? <><HandCoins className="h-4 w-4 mr-2" />Emprunter</>
              : <><Undo2 className="h-4 w-4 mr-2" />Rembourser</>}
        </Button>
      </div>

      <TxStatus state={txState} hash={txHash} error={txError} />
      {!address && <p className="text-center text-sm text-muted-foreground">Connectez votre portefeuille pour emprunter</p>}
    </div>
  );
}

// ── Panneau Prêteur (US-13) ────────────────────────────────────────────────────
function LendPanel() {
  const { address } = useAccount();
  const lombard = useLombard();
  const { params, pool, lending, wallet, refetch } = lombard;

  const [amountInput, setAmountInput] = useState("");
  const [mode, setMode] = useState<"supply" | "withdraw">("supply");
  const [txState, setTxState] = useState<TxState>("idle");
  const [txHash, setTxHash] = useState<`0x${string}` | undefined>();
  const [txError, setTxError] = useState<string | undefined>();
  const isBusy = txState === "pending" || txState === "confirming";

  const runTx = async (fn: () => Promise<`0x${string}`>, onDone: () => void) => {
    try {
      setTxError(undefined);
      setTxState("pending");
      const hash = await fn();
      setTxHash(hash);
      setTxState("success");
      onDone();
      refetch();
    } catch (e) {
      setTxError(friendlyError(e));
      setTxState("error");
    }
  };

  const handleSupplyWithdraw = () => {
    if (!amountInput || Number(amountInput) <= 0) return;
    if (mode === "supply") runTx(() => lombard.supply(amountInput), () => setAmountInput(""));
    else runTx(() => lombard.withdraw(amountInput), () => setAmountInput(""));
  };

  const handleClaim = () => runTx(() => lombard.claimReward(), () => {});

  const hasReward = lending.pendingReward !== undefined && lending.pendingReward > 0n;

  return (
    <div className="space-y-6">
      {/* Résumé prêteur */}
      <div className="rounded-xl border border-border bg-card p-5 space-y-1">
        <h3 className="font-semibold mb-2">Votre position de prêteur</h3>
        <DetailRow label="Capital fourni" value={`${lending.supplierPrincipalFormatted} USDC`} highlight />
        <DetailRow label="Récompense en attente" value={`${lending.pendingRewardFormatted} USDC`} />
        <DetailRow label="Part prêteur sur les intérêts" value={params.supplierSharePercent + "/an"} />
        <DetailRow label="Total fourni au pool" value={`${pool.totalSuppliedFormatted} USDC`} />
        <DetailRow label="Liquidité disponible" value={`${pool.availableLiquidityFormatted} USDC`} />
      </div>

      {hasReward && (
        <div className="rounded-xl border border-border bg-card p-5 flex items-center justify-between gap-4">
          <div className="flex items-center gap-2">
            <Gift className="h-5 w-5 text-primary" />
            <div>
              <p className="font-medium text-sm">Récompense disponible</p>
              <p className="text-xs text-muted-foreground">{lending.pendingRewardFormatted} USDC</p>
            </div>
          </div>
          <Button size="sm" variant="outline" disabled={isBusy} onClick={handleClaim}>
            {isBusy ? <Loader2 className="h-4 w-4 animate-spin" /> : "Réclamer"}
          </Button>
        </div>
      )}

      {/* Dépôt / retrait */}
      <div className="rounded-xl border border-border bg-card p-5 space-y-4">
        <div className="flex items-center justify-between">
          <h3 className="font-semibold">Capital prêteur (USDC)</h3>
          <span className="text-xs text-muted-foreground">Solde : {wallet.usdcBalanceFormatted} USDC</span>
        </div>
        <div className="flex rounded-lg border border-border overflow-hidden text-sm">
          {(["supply", "withdraw"] as const).map((m) => (
            <button key={m} onClick={() => setMode(m)}
              className={`flex-1 py-2 font-medium transition-colors ${
                mode === m ? "bg-primary text-primary-foreground" : "bg-background text-muted-foreground hover:bg-muted"
              }`}>
              {m === "supply" ? "Déposer" : "Retirer"}
            </button>
          ))}
        </div>
        <div className="relative">
          <Input type="number" placeholder="0.0" value={amountInput}
            onChange={(e) => setAmountInput(e.target.value)}
            className="pr-16" min="0" step="0.01" />
          <span className="absolute right-3 top-1/2 -translate-y-1/2 text-sm text-muted-foreground">USDC</span>
        </div>
        {mode === "withdraw" && (
          <p className="text-xs text-muted-foreground">
            Retrait « best effort » — plafonné à la liquidité réellement disponible dans le pool.
          </p>
        )}
        <Button className="w-full" variant={mode === "supply" ? "default" : "outline"}
          disabled={!address || isBusy || !amountInput || Number(amountInput) <= 0}
          onClick={handleSupplyWithdraw}>
          {isBusy ? <><Loader2 className="h-4 w-4 mr-2 animate-spin" />En cours...</>
            : mode === "supply"
              ? <><ArrowDownToLine className="h-4 w-4 mr-2" />Déposer</>
              : <><ArrowUpFromLine className="h-4 w-4 mr-2" />Retirer</>}
        </Button>
      </div>

      <TxStatus state={txState} hash={txHash} error={txError} />
      {!address && <p className="text-center text-sm text-muted-foreground">Connectez votre portefeuille pour prêter</p>}
    </div>
  );
}

// ── Activité récente — events natifs LombardVault (pas d'EventLogger, cf. Annexe 09 §6) ──
type ActivityEntry = {
  type: "DEPOSIT" | "WITHDRAW_COLLATERAL" | "BORROW" | "REPAY" | "SUPPLY" | "WITHDRAW_SUPPLY" | "CLAIM_REWARD" | "LIQUIDATED";
  amountGLD?: bigint;
  amountUSDC?: bigint;
  txHash: string;
  blockNumber: bigint;
};

const ACTIVITY_CONFIG: Record<ActivityEntry["type"], { label: string; icon: any; color: string; bg: string }> = {
  DEPOSIT:              { label: "Dépôt collatéral",   icon: ArrowDownToLine, color: "text-blue-500",   bg: "bg-blue-500/10" },
  WITHDRAW_COLLATERAL:  { label: "Retrait collatéral",  icon: ArrowUpFromLine, color: "text-orange-500", bg: "bg-orange-500/10" },
  BORROW:               { label: "Emprunt",             icon: HandCoins,       color: "text-primary",    bg: "bg-primary/10" },
  REPAY:                { label: "Remboursement",       icon: Undo2,           color: "text-green-500",  bg: "bg-green-500/10" },
  SUPPLY:               { label: "Dépôt prêteur",       icon: ArrowDownToLine, color: "text-blue-500",   bg: "bg-blue-500/10" },
  WITHDRAW_SUPPLY:      { label: "Retrait prêteur",     icon: ArrowUpFromLine, color: "text-orange-500", bg: "bg-orange-500/10" },
  CLAIM_REWARD:         { label: "Récompense réclamée", icon: Gift,            color: "text-green-500",  bg: "bg-green-500/10" },
  LIQUIDATED:           { label: "Liquidation",         icon: ShieldAlert,     color: "text-destructive", bg: "bg-destructive/10" },
};

function ActivityFeed() {
  const { address } = useAccount();
  const { lombardVault } = useContracts();
  const [entries, setEntries] = useState<ActivityEntry[]>([]);
  const [isLoading, setIsLoading] = useState(false);

  const eventByName = useMemo(() => {
    const abi = lombardVault.abi as unknown as any[];
    const map: Record<string, any> = {};
    for (const item of abi) if (item.type === "event") map[item.name] = item;
    return map;
  }, [lombardVault.abi]);

  const fetchActivity = async () => {
    if (!address) { setEntries([]); return; }
    setIsLoading(true);
    try {
      const latestBlock = await publicClient.getBlockNumber();
      const fromBlock = latestBlock > 50_000n ? latestBlock - 50_000n : 0n;
      const base = { address: lombardVault.address as `0x${string}`, fromBlock };

      const [deposited, withdrawn, borrowed, repaid, supplied, supplyWithdrawn, claimed, liquidated] =
        await Promise.all([
          publicClient.getLogs({ ...base, event: eventByName.CollateralDeposited, args: { user: address } }),
          publicClient.getLogs({ ...base, event: eventByName.CollateralWithdrawn, args: { user: address } }),
          publicClient.getLogs({ ...base, event: eventByName.Borrowed,            args: { user: address } }),
          publicClient.getLogs({ ...base, event: eventByName.Repaid,              args: { user: address } }),
          publicClient.getLogs({ ...base, event: eventByName.Supplied,            args: { user: address } }),
          publicClient.getLogs({ ...base, event: eventByName.SupplyWithdrawn,     args: { user: address } }),
          publicClient.getLogs({ ...base, event: eventByName.RewardClaimed,       args: { user: address } }),
          publicClient.getLogs({ ...base, event: eventByName.Liquidated,          args: { borrower: address } }),
        ]);

      const list: ActivityEntry[] = [
        ...deposited.map((l: any) => ({ type: "DEPOSIT" as const, amountGLD: l.args.amount, txHash: l.transactionHash, blockNumber: l.blockNumber })),
        ...withdrawn.map((l: any) => ({ type: "WITHDRAW_COLLATERAL" as const, amountGLD: l.args.amount, txHash: l.transactionHash, blockNumber: l.blockNumber })),
        ...borrowed.map((l: any) => ({ type: "BORROW" as const, amountUSDC: l.args.amount, txHash: l.transactionHash, blockNumber: l.blockNumber })),
        ...repaid.map((l: any) => ({ type: "REPAY" as const, amountUSDC: (l.args.interestPortion ?? 0n) + (l.args.principalPortion ?? 0n), txHash: l.transactionHash, blockNumber: l.blockNumber })),
        ...supplied.map((l: any) => ({ type: "SUPPLY" as const, amountUSDC: l.args.amount, txHash: l.transactionHash, blockNumber: l.blockNumber })),
        ...supplyWithdrawn.map((l: any) => ({ type: "WITHDRAW_SUPPLY" as const, amountUSDC: l.args.actual, txHash: l.transactionHash, blockNumber: l.blockNumber })),
        ...claimed.map((l: any) => ({ type: "CLAIM_REWARD" as const, amountUSDC: l.args.amount, txHash: l.transactionHash, blockNumber: l.blockNumber })),
        ...liquidated.map((l: any) => ({ type: "LIQUIDATED" as const, amountGLD: l.args.collateralSeized, amountUSDC: l.args.usdcRecovered, txHash: l.transactionHash, blockNumber: l.blockNumber })),
      ].sort((a, b) => Number(b.blockNumber - a.blockNumber));

      setEntries(list.slice(0, 30));
    } catch (e) {
      console.error("Erreur getLogs LombardVault :", e);
    } finally {
      setIsLoading(false);
    }
  };

  useEffect(() => {
    fetchActivity();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [address]);

  if (!address) return null;

  return (
    <div className="rounded-xl border border-border bg-card p-5 space-y-3">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <History className="h-4 w-4 text-muted-foreground" />
          <h3 className="font-semibold text-sm">Activité récente</h3>
        </div>
        <Button variant="ghost" size="sm" onClick={fetchActivity} disabled={isLoading}>
          <RefreshCw className={`h-3.5 w-3.5 ${isLoading ? "animate-spin" : ""}`} />
        </Button>
      </div>
      <p className="text-[11px] text-muted-foreground -mt-2">
        Lu directement depuis les events du contrat (LombardVault ne journalise pas dans l&apos;historique global).
      </p>
      {isLoading ? (
        <div className="flex justify-center py-6"><RefreshCw className="h-5 w-5 animate-spin text-muted-foreground" /></div>
      ) : entries.length === 0 ? (
        <p className="text-sm text-muted-foreground text-center py-4">Aucune opération sur les ~50 000 derniers blocs.</p>
      ) : (
        entries.map((entry, i) => {
          const cfg = ACTIVITY_CONFIG[entry.type];
          const Icon = cfg.icon;
          return (
            <div key={`${entry.txHash}-${i}`} className="flex items-center gap-3 py-2 border-b border-border last:border-0">
              <div className={`p-2 rounded-lg ${cfg.bg} ${cfg.color} shrink-0`}><Icon className="h-3.5 w-3.5" /></div>
              <div className="flex-1 min-w-0">
                <p className="text-sm font-medium">{cfg.label}</p>
                <a href={`https://sepolia.etherscan.io/tx/${entry.txHash}`} target="_blank" rel="noopener noreferrer"
                  className="text-xs text-primary hover:underline">Etherscan ↗</a>
              </div>
              <div className="text-right text-sm font-medium">
                {entry.amountGLD !== undefined && <p>{formatUnits(entry.amountGLD, GLD_DECIMALS)} GLD</p>}
                {entry.amountUSDC !== undefined && <p>{formatUnits(entry.amountUSDC, USDC_DECIMALS)} USDC</p>}
              </div>
            </div>
          );
        })
      )}
    </div>
  );
}

// ── Page ────────────────────────────────────────────────────────────────────────
export default function LombardPage() {
  const t = useTranslations("lombard");
  const { address } = useAccount();
  const [mounted, setMounted] = useState(false);
  useEffect(() => { setMounted(true); }, []);

  if (!mounted) return null;

  return (
    <div className="max-w-lg mx-auto space-y-6">
      <div className="text-center space-y-2">
        <div className="flex items-center justify-center gap-2">
          <Landmark className="h-6 w-6 text-primary" />
          <h1 className="text-3xl font-bold">{t("title")}</h1>
        </div>
        <p className="text-muted-foreground text-sm">{t("subtitle")}</p>
      </div>

      <div className="rounded-xl border border-border bg-card p-6 shadow-sm">
        <Tabs defaultValue="borrow">
          <TabsList className="w-full mb-6">
            <TabsTrigger value="borrow" className="flex-1">{t("tab_borrow")}</TabsTrigger>
            <TabsTrigger value="lend"   className="flex-1">{t("tab_lend")}</TabsTrigger>
          </TabsList>
          <TabsContent value="borrow"><BorrowPanel /></TabsContent>
          <TabsContent value="lend">  <LendPanel />  </TabsContent>
        </Tabs>
      </div>

      {address && <ActivityFeed />}

      <p className="text-center text-xs text-muted-foreground px-4">
        Le collatéral GLD déposé doit provenir d&apos;un wallet vérifié KYC (IdentityRegistry) — un wallet non conforme verra son dépôt échouer.
      </p>
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

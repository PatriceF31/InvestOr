import type { GetStaticPropsContext } from "next";
import { useState, useEffect } from "react";
import { useTranslations } from "next-intl";
import { useAccount, useReadContract, useWriteContract, useWaitForTransactionReceipt } from "wagmi";
import { parseUnits } from "viem";
import { useContracts } from "@/hooks/useContracts";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Separator } from "@/components/ui/separator";
import { Settings, Shield, AlertTriangle, Loader2, CheckCircle2, Lock, Unlock } from "lucide-react";

function AdminCard({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="rounded-xl border border-border bg-card p-6 space-y-4">
      <h3 className="font-semibold text-base">{title}</h3>
      <Separator />
      {children}
    </div>
  );
}

function ActionRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="space-y-2">
      <Label className="text-sm">{label}</Label>
      {children}
    </div>
  );
}

export default function AdminPage() {
  const t = useTranslations("admin");
  const { address, isConnected } = useAccount();
  const { gld, treasury, exchange, reserve } = useContracts();
  const [mounted, setMounted] = useState(false);
  useEffect(() => { setMounted(true); }, []);

  // États des inputs
  const [minterAddr,    setMinterAddr]    = useState("");
  const [operatorAddr,  setOperatorAddr]  = useState("");
  const [oracleAddr,    setOracleAddr]    = useState("");
  const [fallbackPrice, setFallbackPrice] = useState("");
  const [minRatio,      setMinRatio]      = useState("");
  const [blacklistAddr, setBlacklistAddr] = useState("");
  const [emergencyTo,   setEmergencyTo]   = useState("");

  const { writeContractAsync, isPending } = useWriteContract();
  const [txHash, setTxHash] = useState<`0x${string}` | undefined>();
  const { isLoading: isConfirming, isSuccess: isConfirmed } =
    useWaitForTransactionReceipt({ hash: txHash });

  // Vérifier si l'adresse connectée est owner de GLD
  const { data: gldOwner }      = useReadContract({ ...gld,      functionName: "owner" });
  const { data: exchangePaused } = useReadContract({ ...exchange, functionName: "paused" });
  const { data: gldMinter }     = useReadContract({ ...gld,      functionName: "minter" });
  const { data: treasuryOp }    = useReadContract({ ...treasury, functionName: "operator" });

  const isOwner  = isConnected && address?.toLowerCase() === (gldOwner as string)?.toLowerCase();
  const isLoading = isPending || isConfirming;

  const exec = async (fn: () => Promise<`0x${string}`>) => {
    try { setTxHash(await fn()); } catch {}
  };

  if (!mounted) return null;

  if (!isConnected) {
    return (
      <div className="max-w-2xl mx-auto text-center py-16 space-y-4">
        <Settings className="h-12 w-12 mx-auto text-muted-foreground" />
        <p className="text-muted-foreground">Connectez votre portefeuille pour accéder à l'administration.</p>
      </div>
    );
  }

  if (!isOwner) {
    return (
      <div className="max-w-2xl mx-auto text-center py-16 space-y-4">
        <AlertTriangle className="h-12 w-12 mx-auto text-destructive" />
        <p className="font-semibold text-destructive">Accès refusé</p>
        <p className="text-muted-foreground text-sm">
          Seul le owner des contrats peut accéder à cette page.
        </p>
      </div>
    );
  }

  return (
    <div className="max-w-2xl mx-auto space-y-6">

      {/* En-tête */}
      <div className="flex items-center gap-3">
        <Settings className="h-7 w-7 text-primary" />
        <div>
          <h1 className="text-3xl font-bold">{t("title")}</h1>
          <p className="text-muted-foreground text-sm">Gestion des contrats du protocole</p>
        </div>
        <Badge className="ml-auto">Owner</Badge>
      </div>

      {/* Statut tx */}
      {(isPending || isConfirming || isConfirmed) && (
        <div className={`rounded-lg p-4 flex items-center gap-3 text-sm ${
          isConfirmed ? "bg-green-500/10 border border-green-500/20" : "bg-primary/10 border border-primary/20"
        }`}>
          {isLoading   && <Loader2    className="h-4 w-4 animate-spin text-primary" />}
          {isConfirmed && <CheckCircle2 className="h-4 w-4 text-green-500" />}
          <span>{isLoading ? "Transaction en cours..." : "Transaction réussie !"}</span>
          {txHash && <span className="font-mono text-xs ml-auto">{txHash.slice(0,10)}...</span>}
        </div>
      )}

      {/* GLD */}
      <AdminCard title="GLD Token">
        <ActionRow label={t("set_minter")}>
          <div className="text-xs text-muted-foreground mb-2">
            Actuel : <span className="font-mono">{(gldMinter as string) || "—"}</span>
          </div>
          <div className="flex gap-2">
            <Input placeholder="0x..." value={minterAddr} onChange={e => setMinterAddr(e.target.value)} className="font-mono text-sm" />
            <Button disabled={!minterAddr || isLoading}
              onClick={() => exec(() => writeContractAsync({ ...gld, functionName: "setMinter", args: [minterAddr as `0x${string}`] }))}>
              {isLoading ? <Loader2 className="h-4 w-4 animate-spin" /> : "OK"}
            </Button>
          </div>
        </ActionRow>
        <Separator />
        <ActionRow label={t("blacklist")}>
          <div className="flex gap-2">
            <Input placeholder="0x..." value={blacklistAddr} onChange={e => setBlacklistAddr(e.target.value)} className="font-mono text-sm" />
            <Button variant="destructive" disabled={!blacklistAddr || isLoading}
              onClick={() => exec(() => writeContractAsync({ ...gld, functionName: "blacklist", args: [blacklistAddr as `0x${string}`] }))}>
              {isLoading ? <Loader2 className="h-4 w-4 animate-spin" /> : <Shield className="h-4 w-4" />}
            </Button>
          </div>
        </ActionRow>
      </AdminCard>

      {/* Treasury */}
      <AdminCard title="Treasury">
        <ActionRow label={t("set_operator")}>
          <div className="text-xs text-muted-foreground mb-2">
            Actuel : <span className="font-mono">{(treasuryOp as string) || "—"}</span>
          </div>
          <div className="flex gap-2">
            <Input placeholder="0x..." value={operatorAddr} onChange={e => setOperatorAddr(e.target.value)} className="font-mono text-sm" />
            <Button disabled={!operatorAddr || isLoading}
              onClick={() => exec(() => writeContractAsync({ ...treasury, functionName: "setOperator", args: [operatorAddr as `0x${string}`] }))}>
              {isLoading ? <Loader2 className="h-4 w-4 animate-spin" /> : "OK"}
            </Button>
          </div>
        </ActionRow>
        <Separator />
        <ActionRow label={t("emergency_withdraw")}>
          <div className="flex gap-2">
            <Input placeholder="Adresse destinataire 0x..." value={emergencyTo} onChange={e => setEmergencyTo(e.target.value)} className="font-mono text-sm" />
            <Button variant="destructive" disabled={!emergencyTo || isLoading}
              onClick={() => exec(() => writeContractAsync({ ...treasury, functionName: "emergencyWithdraw", args: [emergencyTo as `0x${string}`] }))}>
              {isLoading ? <Loader2 className="h-4 w-4 animate-spin" /> : "⚠️"}
            </Button>
          </div>
        </ActionRow>
      </AdminCard>

      {/* Exchange */}
      <AdminCard title="Exchange">
        <div className="flex items-center justify-between">
          <div>
            <p className="text-sm font-medium">Statut Exchange</p>
            <p className="text-xs text-muted-foreground">{exchangePaused ? "Pausé" : "Actif"}</p>
          </div>
          <Button
            variant={exchangePaused ? "default" : "destructive"}
            size="sm"
            disabled={isLoading}
            onClick={() => exec(() => writeContractAsync({
              ...exchange,
              functionName: exchangePaused ? "unpause" : "pause",
            }))}>
            {exchangePaused
              ? <><Unlock className="h-4 w-4 mr-2" />{t("unpause_exchange")}</>
              : <><Lock   className="h-4 w-4 mr-2" />{t("pause_exchange")}</>
            }
          </Button>
        </div>
        <Separator />
        <ActionRow label={t("set_oracle")}>
          <div className="flex gap-2">
            <Input placeholder="0x... (0x0 pour désactiver)" value={oracleAddr} onChange={e => setOracleAddr(e.target.value)} className="font-mono text-sm" />
            <Button disabled={!oracleAddr || isLoading}
              onClick={() => exec(() => writeContractAsync({ ...exchange, functionName: "setOracle", args: [oracleAddr as `0x${string}`] }))}>
              {isLoading ? <Loader2 className="h-4 w-4 animate-spin" /> : "OK"}
            </Button>
          </div>
        </ActionRow>
        <Separator />
        <ActionRow label={`${t("set_fallback_price")} (8 décimales, ex: 9000000000 = $90)`}>
          <div className="flex gap-2">
            <Input type="number" placeholder="9000000000" value={fallbackPrice} onChange={e => setFallbackPrice(e.target.value)} />
            <Button disabled={!fallbackPrice || isLoading}
              onClick={() => exec(() => writeContractAsync({ ...exchange, functionName: "setFallbackPrice", args: [BigInt(fallbackPrice)] }))}>
              {isLoading ? <Loader2 className="h-4 w-4 animate-spin" /> : "OK"}
            </Button>
          </div>
        </ActionRow>
      </AdminCard>

      {/* Reserve */}
      <AdminCard title="Reserve">
        <ActionRow label={`${t("set_min_ratio")} (bps, ex: 10000 = 100%, 11000 = 110%)`}>
          <div className="flex gap-2">
            <Input type="number" placeholder="10000" value={minRatio} onChange={e => setMinRatio(e.target.value)} />
            <Button disabled={!minRatio || isLoading}
              onClick={() => exec(() => writeContractAsync({ ...reserve, functionName: "setMinRatio", args: [BigInt(minRatio)] }))}>
              {isLoading ? <Loader2 className="h-4 w-4 animate-spin" /> : "OK"}
            </Button>
          </div>
        </ActionRow>
      </AdminCard>

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

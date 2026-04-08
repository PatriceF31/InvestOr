import type { GetStaticPropsContext } from "next";
import { useState, useEffect } from "react";
import { useTranslations } from "next-intl";
import { useAccount, useReadContract, useWriteContract, useWaitForTransactionReceipt } from "wagmi";
import { formatUnits, parseUnits } from "viem";
import { useContracts } from "@/hooks/useContracts";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Separator } from "@/components/ui/separator";
import { Shield, RefreshCw, AlertTriangle, CheckCircle, Loader2, TrendingDown } from "lucide-react";
import { waitForTransactionReceipt } from "wagmi/actions";
import { wagmiConfig } from "@/lib/wagmi.config";

function DetailRow({ label, value, highlight }: { label: string; value: string; highlight?: boolean }) {
  return (
    <div className="flex items-center justify-between py-2">
      <span className="text-sm text-muted-foreground">{label}</span>
      <span className={`text-sm font-semibold ${highlight ? "text-primary" : ""}`}>{value}</span>
    </div>
  );
}

export default function ReservePage() {
  const t = useTranslations("reserve");
  const { address, isConnected } = useAccount();
  const { reserve, treasury, gld } = useContracts();

  // Vérifier si l'adresse connectée est owner
  const { data: ownerAddress } = useReadContract({ ...gld, functionName: "owner" });
  const isOwner = isConnected && address !== undefined && ownerAddress !== undefined &&
    address.toLowerCase() === (ownerAddress as string).toLowerCase();
  // Vérifier si l'adresse connectée est recapitalisatrice
  const { data: isRecapitalizer } = useReadContract({
    ...reserve,
    functionName: "recapitalizers",
    args: address ? [address] : undefined,
    query: { enabled: !!address },
  });

  const canRecapitalize = isOwner || !!isRecapitalizer;
  const [mounted, setMounted] = useState(false);
  const [recapAmount, setRecapAmount] = useState("");
  const [txHash, setTxHash] = useState<`0x${string}` | undefined>();

  useEffect(() => { setMounted(true); }, []);

  const { writeContractAsync, isPending } = useWriteContract();
  const { isLoading: isConfirming, isSuccess: isConfirmed } =
    useWaitForTransactionReceipt({ hash: txHash });

  // État complet de la réserve
  const { data: statusRaw, refetch, isLoading } = useReadContract({
    ...reserve,
    functionName: "getReserveStatus",
    query: { refetchInterval: 30_000 },
  });

  const status = statusRaw as readonly [
    bigint, bigint, bigint, bigint, bigint, boolean, boolean, bigint, bigint
  ] | undefined;

  const usdcReserve    = status?.[0];
  const gldSupply      = status?.[1];
  const goldValueUsdc  = status?.[2];
  const ratioBps       = status?.[3];
  const minRatioBps    = status?.[4];
  const healthy        = status?.[5] ?? true;
  const exchangePaused = status?.[6] ?? false;
  const price          = status?.[7];
  const deficitUsdc    = status?.[8];

  // MaxUint256 → gldSupply = 0 → ratio infini → afficher "∞"
  const ratioPercent = (() => {
    if (ratioBps === undefined) return "—";
    if (ratioBps > 100_000n) return "∞";
    return (Number(ratioBps) / 100).toFixed(1);
  })();
  const minRatioPercent = minRatioBps !== undefined ? (Number(minRatioBps) / 100).toFixed(0) : "—";
  const lastCheck      = "—"; // timestamp non disponible via getReserveStatus

  // Adresse USDC pour recapitalize
  const { data: usdcAddress } = useReadContract({
    ...treasury, functionName: "usdc",
  });

  const handleProofOfReserve = async () => {
    try {
      const tx = await writeContractAsync({
        ...reserve, functionName: "proofOfReserve",
      });
      setTxHash(tx);
    } catch {}
  };

  const handleRecapitalize = async () => {
    if (!recapAmount || !usdcAddress) return;
    const parsed = parseUnits(recapAmount, 6);
    try {
      // 1. Approve et attendre confirmation
      const approveTx = await writeContractAsync({
        address: usdcAddress as `0x${string}`,
        abi: [{ name: "approve", type: "function", stateMutability: "nonpayable",
          inputs: [{ name: "s", type: "address" }, { name: "a", type: "uint256" }],
          outputs: [{ type: "bool" }] }] as const,
        functionName: "approve",
        args: [reserve.address, parsed],
      });
      await waitForTransactionReceipt(wagmiConfig, { hash: approveTx });

      // 2. Recapitalize
      const tx = await writeContractAsync({
        ...reserve, functionName: "recapitalize", args: [parsed],
      });
      setTxHash(tx);
      setRecapAmount("");
    } catch {}
  };

  if (!mounted) return null;

  const isLoading2 = isPending || isConfirming;

  return (
    <div className="max-w-2xl mx-auto space-y-6">

      {/* En-tête */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <Shield className="h-7 w-7 text-primary" />
          <div>
            <h1 className="text-3xl font-bold">{t("title")}</h1>
            <p className="text-muted-foreground text-sm">Preuve de collatéralisation on-chain</p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <Badge variant={healthy ? "default" : "destructive"} className="text-sm px-3 py-1">
            {healthy
              ? <><CheckCircle className="h-3 w-3 mr-1" />{t("status_healthy")}</>
              : <><AlertTriangle className="h-3 w-3 mr-1" />{t("status_at_risk")}</>
            }
          </Badge>
        </div>
      </div>

      {/* Alerte déficit */}
      {!healthy && deficitUsdc !== undefined && (
        <div className="rounded-lg border border-destructive/50 bg-destructive/10 p-4 flex items-start gap-3">
          <TrendingDown className="h-5 w-5 text-destructive mt-0.5 shrink-0" />
          <div className="space-y-1">
            <p className="font-semibold text-destructive">Déficit de collatéral détecté</p>
            <p className="text-sm text-destructive/80">
              Déficit : {formatUnits(deficitUsdc, 6)} USDC à injecter pour restaurer le ratio minimum.
            </p>
            {exchangePaused && (
              <p className="text-sm font-medium text-destructive">⚠️ L'Exchange a été automatiquement pausé.</p>
            )}
          </div>
        </div>
      )}

      {/* Métriques principales */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
        <div className="rounded-xl border border-border bg-card p-5 space-y-2 text-center">
          <p className="text-xs text-muted-foreground uppercase tracking-wide">{t("ratio")}</p>
          <p className={`text-4xl font-bold ${healthy ? "text-primary" : "text-destructive"}`}>
            {ratioPercent}%
          </p>
          <p className="text-xs text-muted-foreground">Min requis : {minRatioPercent}%</p>
        </div>
        <div className="rounded-xl border border-border bg-card p-5 space-y-2 text-center">
          <p className="text-xs text-muted-foreground uppercase tracking-wide">{t("usdc_reserve")}</p>
          <p className="text-2xl font-bold">
            {usdcReserve !== undefined ? formatUnits(usdcReserve, 6) : "—"}
          </p>
          <p className="text-xs text-muted-foreground">USDC</p>
        </div>
        <div className="rounded-xl border border-border bg-card p-5 space-y-2 text-center">
          <p className="text-xs text-muted-foreground uppercase tracking-wide">{t("gold_value")}</p>
          <p className="text-2xl font-bold">
            {goldValueUsdc !== undefined ? formatUnits(goldValueUsdc, 6) : "—"}
          </p>
          <p className="text-xs text-muted-foreground">USDC</p>
        </div>
      </div>

      {/* Détails */}
      <div className="rounded-xl border border-border bg-card p-6 space-y-1">
        <h2 className="font-semibold mb-3">Détails</h2>
        <Separator className="mb-3" />
        <DetailRow label={t("gld_supply")}
          value={gldSupply !== undefined ? `${formatUnits(gldSupply, 3)} GLD` : "—"} />
        <DetailRow label="Prix or"
          value={price !== undefined ? `$${(Number(price) / 1e8).toFixed(2)} / g` : "—"}
          highlight />
        <DetailRow label={t("usdc_reserve")}
          value={usdcReserve !== undefined ? `${formatUnits(usdcReserve, 6)} USDC` : "—"} />
        <DetailRow label={t("gold_value")}
          value={goldValueUsdc !== undefined ? `${formatUnits(goldValueUsdc, 6)} USDC` : "—"} />
        <DetailRow label={t("ratio")} value={`${ratioPercent}%`} highlight />
        <DetailRow label={t("min_ratio")} value={`${minRatioPercent}%`} />
        <DetailRow label="Exchange" value={exchangePaused ? "⚠️ Pausé" : "✓ Actif"} />
      </div>

      {/* Actions */}
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
        {/* Vérifier la réserve */}
        <div className="rounded-xl border border-border bg-card p-6 space-y-4">
          <div>
            <h3 className="font-semibold">{t("proof_of_reserve")}</h3>
            <p className="text-sm text-muted-foreground mt-1">
              Vérifie le ratio et pause Exchange si insuffisant.
              Appelable par n'importe qui.
            </p>
          </div>
          <Button className="w-full" onClick={handleProofOfReserve}
            disabled={isLoading2}>
            {isLoading2
              ? <><Loader2 className="h-4 w-4 mr-2 animate-spin" />En cours...</>
              : <><RefreshCw className="h-4 w-4 mr-2" />{t("proof_of_reserve")}</>
            }
          </Button>
          {isConfirmed && (
            <p className="text-xs text-green-600 flex items-center gap-1">
              <CheckCircle className="h-3 w-3" /> Vérification effectuée
            </p>
          )}
        </div>

        {/* Recapitaliser — admin uniquement */}
        {canRecapitalize && <div className="rounded-xl border border-border bg-card p-6 space-y-4">
          <div>
            <h3 className="font-semibold">{t("recapitalize")}</h3>
            <p className="text-sm text-muted-foreground mt-1">
              Injecter des USDC pour restaurer le ratio.
              {deficitUsdc !== undefined && deficitUsdc > 0n && (
                <span className="text-destructive font-medium">
                  {" "}Déficit : {formatUnits(deficitUsdc, 6)} USDC
                </span>
              )}
            </p>
          </div>
          <div className="relative">
            <Input type="number" placeholder="Montant USDC" value={recapAmount}
              onChange={e => setRecapAmount(e.target.value)} className="pr-16" min="0" />
            <span className="absolute right-3 top-1/2 -translate-y-1/2 text-xs text-muted-foreground">USDC</span>
          </div>
          {deficitUsdc !== undefined && deficitUsdc > 0n && (
            <Button variant="ghost" size="sm" className="text-xs text-primary p-0 h-auto"
              onClick={() => setRecapAmount(formatUnits(deficitUsdc, 6))}>
              Remplir le déficit
            </Button>
          )}
          <Button className="w-full" variant="outline"
            onClick={handleRecapitalize}
            disabled={!recapAmount || Number(recapAmount) <= 0 || isLoading2 || !address}>
            {isLoading2
              ? <><Loader2 className="h-4 w-4 mr-2 animate-spin" />En cours...</>
              : t("recapitalize")
            }
          </Button>
        </div>}
      </div>

      <Button variant="ghost" size="sm" className="w-full text-muted-foreground"
        onClick={() => refetch()} disabled={isLoading}>
        <RefreshCw className={`h-4 w-4 mr-2 ${isLoading ? "animate-spin" : ""}`} />
        Rafraîchir les données
      </Button>
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

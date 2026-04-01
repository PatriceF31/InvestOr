import type { GetStaticPropsContext } from "next";
import { useState, useEffect } from "react";
import { useTranslations } from "next-intl";
import { useAccount, useReadContract } from "wagmi";
import { formatUnits, parseUnits } from "viem";
import { useContracts } from "@/hooks/useContracts";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Badge } from "@/components/ui/badge";
import { Separator } from "@/components/ui/separator";
import { ArrowDownUp, TrendingUp, AlertCircle, CheckCircle2, Loader2 } from "lucide-react";
import { useWriteContract, useWaitForTransactionReceipt } from "wagmi";

// ── Composant ligne de détail ─────────────────────────────────────────────────
function DetailRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between text-sm">
      <span className="text-muted-foreground">{label}</span>
      <span className="font-medium">{value}</span>
    </div>
  );
}

// ── Statut de transaction ─────────────────────────────────────────────────────
function TxStatus({ isPending, isConfirming, isConfirmed, isError, hash }: {
  isPending: boolean;
  isConfirming: boolean;
  isConfirmed: boolean;
  isError: boolean;
  hash?: `0x${string}`;
}) {
  if (!isPending && !isConfirming && !isConfirmed && !isError) return null;

  return (
    <div className={`rounded-lg p-4 flex items-start gap-3 text-sm ${
      isConfirmed ? "bg-green-500/10 border border-green-500/20" :
      isError     ? "bg-destructive/10 border border-destructive/20" :
                    "bg-primary/10 border border-primary/20"
    }`}>
      {(isPending || isConfirming) && <Loader2 className="h-4 w-4 animate-spin mt-0.5 text-primary shrink-0" />}
      {isConfirmed && <CheckCircle2 className="h-4 w-4 mt-0.5 text-green-500 shrink-0" />}
      {isError && <AlertCircle className="h-4 w-4 mt-0.5 text-destructive shrink-0" />}
      <div className="space-y-1">
        <p className="font-medium">
          {isPending    && "Confirmez dans votre portefeuille..."}
          {isConfirming && "Transaction en cours..."}
          {isConfirmed  && "Transaction réussie !"}
          {isError      && "Erreur de transaction"}
        </p>
        {hash && (
          <p className="text-xs text-muted-foreground font-mono">
            {hash.slice(0, 10)}...{hash.slice(-8)}
          </p>
        )}
      </div>
    </div>
  );
}

// ── Panneau Achat ─────────────────────────────────────────────────────────────
function BuyPanel() {
  const t = useTranslations("trade");
  const { address } = useAccount();
  const { exchange, treasury } = useContracts();
  const [usdcInput, setUsdcInput] = useState("");
  const [step, setStep] = useState<"idle" | "approving" | "buying">("idle");

  const { writeContractAsync, isPending, isError } = useWriteContract();
  const [txHash, setTxHash] = useState<`0x${string}` | undefined>();
  const { isLoading: isConfirming, isSuccess: isConfirmed } =
    useWaitForTransactionReceipt({ hash: txHash });

  // Prix actuel
  const { data: priceRaw } = useReadContract({
    ...exchange,
    functionName: "getPrice",
  });
  const priceData = priceRaw as [bigint, boolean] | undefined;
  const price    = priceData?.[0];
  const isOracle = priceData?.[1] ?? false;

  // Preview
  const usdcParsed = usdcInput && Number(usdcInput) > 0
    ? parseUnits(usdcInput, 6) : undefined;

  const { data: gldPreview } = useReadContract({
    ...exchange,
    functionName: "previewBuy",
    args: usdcParsed ? [usdcParsed] : undefined,
    query: { enabled: !!usdcParsed },
  });

  // Adresse USDC
  const { data: usdcAddress } = useReadContract({
    ...treasury,
    functionName: "usdc",
  });

  // Balance USDC utilisateur
  const { data: usdcBalance } = useReadContract({
    address: usdcAddress as `0x${string}` | undefined,
    abi: [{ name: "balanceOf", type: "function", stateMutability: "view",
      inputs: [{ name: "account", type: "address" }],
      outputs: [{ type: "uint256" }] }] as const,
    functionName: "balanceOf",
    args: address ? [address] : undefined,
    query: { enabled: !!address && !!usdcAddress },
  });

  const gldAmount = gldPreview !== undefined
    ? formatUnits(gldPreview as bigint, 3) : "—";
  const priceStr  = price !== undefined
    ? `$${(Number(price) / 1e8).toFixed(2)}` : "—";
  const balanceStr = usdcBalance !== undefined
    ? formatUnits(usdcBalance as bigint, 6) : "—";

  const handleBuy = async () => {
    if (!usdcParsed || !usdcAddress || !address) return;
    try {
      setStep("approving");
      const approveTx = await writeContractAsync({
        address: usdcAddress as `0x${string}`,
        abi: [{ name: "approve", type: "function", stateMutability: "nonpayable",
          inputs: [{ name: "spender", type: "address" }, { name: "amount", type: "uint256" }],
          outputs: [{ type: "bool" }] }] as const,
        functionName: "approve",
        args: [exchange.address, usdcParsed],
      });
      setTxHash(approveTx);
      setStep("buying");
      const buyTx = await writeContractAsync({
        ...exchange,
        functionName: "buy",
        args: [usdcParsed],
      });
      setTxHash(buyTx);
      setStep("idle");
      setUsdcInput("");
    } catch {
      setStep("idle");
    }
  };

  const isLoading = isPending || isConfirming;

  return (
    <div className="space-y-6">
      {/* Input USDC */}
      <div className="space-y-2">
        <div className="flex items-center justify-between">
          <Label>{t("amount_usdc")}</Label>
          <span className="text-xs text-muted-foreground">
            Solde : {balanceStr} USDC
          </span>
        </div>
        <div className="relative">
          <Input
            type="number"
            placeholder="0.00"
            value={usdcInput}
            onChange={(e) => setUsdcInput(e.target.value)}
            className="pr-16 text-lg"
            min="0"
          />
          <span className="absolute right-3 top-1/2 -translate-y-1/2 text-sm font-medium text-muted-foreground">
            USDC
          </span>
        </div>
        <Button
          variant="ghost"
          size="sm"
          className="text-xs text-primary p-0 h-auto"
          onClick={() => setUsdcInput(balanceStr !== "—" ? balanceStr : "")}
        >
          Max
        </Button>
      </div>

      {/* Flèche */}
      <div className="flex items-center justify-center">
        <div className="rounded-full border border-border bg-background p-2">
          <ArrowDownUp className="h-4 w-4 text-muted-foreground" />
        </div>
      </div>

      {/* Output GLD */}
      <div className="space-y-2">
        <Label>{t("you_receive")}</Label>
        <div className="rounded-lg border border-border bg-muted/30 p-4 flex items-center justify-between">
          <span className="text-2xl font-bold text-primary">
            {gldAmount}
          </span>
          <span className="text-sm font-medium text-muted-foreground">GLD</span>
        </div>
        {gldAmount !== "—" && (
          <p className="text-xs text-muted-foreground">
            ≈ {Number(gldAmount).toFixed(3)} gramme(s) d'or
          </p>
        )}
      </div>

      <Separator />

      {/* Détails */}
      <div className="space-y-2">
        <DetailRow label={t("price_per_gram")} value={priceStr} />
        <DetailRow
          label="Source prix"
          value={isOracle ? "Chainlink Oracle" : "Prix fallback"}
        />
        <DetailRow label="Frais" value="0%" />
        <DetailRow
          label="Étape 1"
          value={step === "approving" ? "✓ Approbation USDC..." : "Approbation USDC"}
        />
        <DetailRow
          label="Étape 2"
          value={step === "buying" ? "✓ Achat GLD..." : "Achat GLD"}
        />
      </div>

      {/* Statut tx */}
      <TxStatus
        isPending={isPending}
        isConfirming={isConfirming}
        isConfirmed={isConfirmed}
        isError={isError}
        hash={txHash}
      />

      {/* Bouton */}
      <Button
        className="w-full"
        size="lg"
        disabled={!usdcInput || Number(usdcInput) <= 0 || isLoading || !address}
        onClick={handleBuy}
      >
        {isLoading
          ? <><Loader2 className="h-4 w-4 mr-2 animate-spin" /> En cours...</>
          : t("buy") + " GLD"
        }
      </Button>

      {!address && (
        <p className="text-center text-sm text-muted-foreground">
          Connectez votre portefeuille pour acheter
        </p>
      )}
    </div>
  );
}

// ── Panneau Vente ─────────────────────────────────────────────────────────────
function SellPanel() {
  const t = useTranslations("trade");
  const { address } = useAccount();
  const { gld, exchange } = useContracts();
  const [gldInput, setGldInput] = useState("");

  const { writeContractAsync, isPending, isError } = useWriteContract();
  const [txHash, setTxHash] = useState<`0x${string}` | undefined>();
  const { isLoading: isConfirming, isSuccess: isConfirmed } =
    useWaitForTransactionReceipt({ hash: txHash });

  // Prix actuel
  const { data: priceRaw } = useReadContract({
    ...exchange,
    functionName: "getPrice",
  });
  const priceData = priceRaw as [bigint, boolean] | undefined;
  const price    = priceData?.[0];
  const isOracle = priceData?.[1] ?? false;

  // Balance GLD utilisateur
  const { data: gldBalance } = useReadContract({
    ...gld,
    functionName: "balanceOf",
    args: address ? [address] : undefined,
    query: { enabled: !!address },
  });

  // Preview
  const gldParsed = gldInput && Number(gldInput) > 0
    ? parseUnits(gldInput, 3) : undefined;

  const { data: usdcPreview } = useReadContract({
    ...exchange,
    functionName: "previewSell",
    args: gldParsed ? [gldParsed] : undefined,
    query: { enabled: !!gldParsed },
  });

  const usdcAmount  = usdcPreview !== undefined
    ? formatUnits(usdcPreview as bigint, 6) : "—";
  const balanceStr  = gldBalance !== undefined
    ? formatUnits(gldBalance as bigint, 3) : "—";
  const priceStr    = price !== undefined
    ? `$${(Number(price) / 1e8).toFixed(2)}` : "—";

  const handleSell = async () => {
    if (!gldParsed || !address) return;
    try {
      const sellTx = await writeContractAsync({
        ...exchange,
        functionName: "sell",
        args: [gldParsed],
      });
      setTxHash(sellTx);
      setGldInput("");
    } catch {}
  };

  const isLoading = isPending || isConfirming;

  return (
    <div className="space-y-6">
      {/* Input GLD */}
      <div className="space-y-2">
        <div className="flex items-center justify-between">
          <Label>{t("amount_gld")}</Label>
          <span className="text-xs text-muted-foreground">
            Solde : {balanceStr} GLD
          </span>
        </div>
        <div className="relative">
          <Input
            type="number"
            placeholder="0.000"
            value={gldInput}
            onChange={(e) => setGldInput(e.target.value)}
            className="pr-16 text-lg"
            min="0"
            step="0.001"
          />
          <span className="absolute right-3 top-1/2 -translate-y-1/2 text-sm font-medium text-muted-foreground">
            GLD
          </span>
        </div>
        <Button
          variant="ghost"
          size="sm"
          className="text-xs text-primary p-0 h-auto"
          onClick={() => setGldInput(balanceStr !== "—" ? balanceStr : "")}
        >
          Max
        </Button>
      </div>

      {/* Flèche */}
      <div className="flex items-center justify-center">
        <div className="rounded-full border border-border bg-background p-2">
          <ArrowDownUp className="h-4 w-4 text-muted-foreground" />
        </div>
      </div>

      {/* Output USDC */}
      <div className="space-y-2">
        <Label>{t("you_receive")}</Label>
        <div className="rounded-lg border border-border bg-muted/30 p-4 flex items-center justify-between">
          <span className="text-2xl font-bold text-primary">
            {usdcAmount}
          </span>
          <span className="text-sm font-medium text-muted-foreground">USDC</span>
        </div>
      </div>

      <Separator />

      {/* Détails */}
      <div className="space-y-2">
        <DetailRow label={t("price_per_gram")} value={priceStr} />
        <DetailRow
          label="Source prix"
          value={isOracle ? "Chainlink Oracle" : "Prix fallback"}
        />
        <DetailRow label="Frais" value="0%" />
      </div>

      {/* Statut tx */}
      <TxStatus
        isPending={isPending}
        isConfirming={isConfirming}
        isConfirmed={isConfirmed}
        isError={isError}
        hash={txHash}
      />

      {/* Bouton */}
      <Button
        className="w-full"
        size="lg"
        variant="outline"
        disabled={!gldInput || Number(gldInput) <= 0 || isLoading || !address}
        onClick={handleSell}
      >
        {isLoading
          ? <><Loader2 className="h-4 w-4 mr-2 animate-spin" /> En cours...</>
          : t("sell") + " GLD"
        }
      </Button>

      {!address && (
        <p className="text-center text-sm text-muted-foreground">
          Connectez votre portefeuille pour vendre
        </p>
      )}
    </div>
  );
}

// ── Page Trade ────────────────────────────────────────────────────────────────
export default function TradePage() {
  const t = useTranslations("trade");
  const { exchange } = useContracts();
  const [mounted, setMounted] = useState(false);
  useEffect(() => { setMounted(true); }, []);

  const { data: exchangePaused } = useReadContract({
    ...exchange,
    functionName: "paused",
  });

  if (!mounted) return null;

  return (
    <div className="max-w-lg mx-auto space-y-6">

      {/* En-tête */}
      <div className="text-center space-y-2">
        <div className="flex items-center justify-center gap-2">
          <TrendingUp className="h-6 w-6 text-primary" />
          <h1 className="text-3xl font-bold">{t("title")}</h1>
        </div>
        <p className="text-muted-foreground text-sm">
          1 GLD = 1 gramme d'or physique tokenisé
        </p>
        {exchangePaused && (
          <Badge variant="destructive">Exchange pausé</Badge>
        )}
      </div>

      {/* Panneau principal */}
      <div className="rounded-xl border border-border bg-card p-6 shadow-sm">
        <Tabs defaultValue="buy">
          <TabsList className="w-full mb-6">
            <TabsTrigger value="buy"  className="flex-1">{t("buy")}</TabsTrigger>
            <TabsTrigger value="sell" className="flex-1">{t("sell")}</TabsTrigger>
          </TabsList>
          <TabsContent value="buy">
            <BuyPanel />
          </TabsContent>
          <TabsContent value="sell">
            <SellPanel />
          </TabsContent>
        </Tabs>
      </div>

      {/* Note légale */}
      <p className="text-center text-xs text-muted-foreground px-4">
        Les transactions sont irréversibles. Vérifiez les montants avant de confirmer.
        Le prix est fourni par Chainlink Oracle.
      </p>
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

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
import { waitForTransactionReceipt } from "wagmi/actions";
import { wagmiConfig } from "@/lib/wagmi.config";

// ── Adresses stablecoins Sepolia ──────────────────────────────────────────────
const USDC_ADDRESS = "0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238" as const;
const EURC_ADDRESS = "0x08210F9170F89Ab7658F0B5E3fF39b0E03C594D4" as const;
type StableToken = "USDC" | "EURC";
const TOKEN_ADDRESS: Record<StableToken, `0x${string}`> = {
  USDC: USDC_ADDRESS,
  EURC: EURC_ADDRESS,
};

const ERC20_ABI = [
  { name: "balanceOf", type: "function", stateMutability: "view",
    inputs: [{ name: "account", type: "address" }], outputs: [{ type: "uint256" }] },
  { name: "approve", type: "function", stateMutability: "nonpayable",
    inputs: [{ name: "spender", type: "address" }, { name: "amount", type: "uint256" }],
    outputs: [{ type: "bool" }] },
] as const;

// ── Sélecteur de token ────────────────────────────────────────────────────────
function TokenSelector({ value, onChange }: {
  value: StableToken;
  onChange: (t: StableToken) => void;
}) {
  return (
    <div className="flex rounded-lg border border-border overflow-hidden">
      {(["USDC", "EURC"] as StableToken[]).map((t) => (
        <button key={t} onClick={() => onChange(t)}
          className={`flex-1 py-2 text-sm font-medium transition-colors ${
            value === t
              ? "bg-primary text-primary-foreground"
              : "bg-background text-muted-foreground hover:bg-muted"
          }`}>
          {t}
        </button>
      ))}
    </div>
  );
}

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
type TxState = "idle" | "pending" | "confirming" | "success" | "error";

function TxStatus({ state, hash }: { state: TxState; hash?: `0x${string}` }) {
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
      </div>
    </div>
  );
}

// ── Panneau Achat ─────────────────────────────────────────────────────────────
function BuyPanel() {
  const t = useTranslations("trade");
  const { address } = useAccount();
  const { exchange } = useContracts();
  const [stableInput, setStableInput] = useState("");
  const [selectedToken, setSelectedToken] = useState<StableToken>("USDC");
  const [step, setStep] = useState<"idle" | "approving" | "buying">("idle");
  const [txHash, setTxHash]   = useState<`0x${string}` | undefined>();
  const [txState, setTxState] = useState<TxState>("idle");

  const { writeContractAsync } = useWriteContract();
  const { isLoading: isConfirming } = useWaitForTransactionReceipt({ hash: txHash });

  const tokenAddress = TOKEN_ADDRESS[selectedToken];

  const { data: feeBps } = useReadContract({ ...exchange, functionName: "feeBps" });
  const feePercent = feeBps !== undefined ? (Number(feeBps) / 100).toFixed(2) + "%" : "0%";

  // Prix — getPrice() retourne (uint256, uint8)
  const { data: priceRaw } = useReadContract({ ...exchange, functionName: "getPrice" });
  const priceData   = priceRaw as [bigint, number] | undefined;
  const price       = priceData?.[0];
  const priceSource = priceData?.[1] ?? 3;
  const isOracle    = priceSource <= 2;

  // Taux EUR/USD — getEurUsdRate() retourne (uint256, bool)
  const { data: eurUsdRaw } = useReadContract({
    ...exchange, functionName: "getEurUsdRate",
    query: { refetchInterval: 60_000 },
  });
  const eurUsdData  = eurUsdRaw as [bigint, boolean] | undefined;
  const eurUsdRate  = eurUsdData?.[0];
  const eurUsdLive  = eurUsdData?.[1] ?? false;
  const eurUsdStr   = eurUsdRate !== undefined
    ? `$${(Number(eurUsdRate) / 1e8).toFixed(4)}`
    : "—";

  const stableParsed = stableInput && Number(stableInput) > 0
    ? parseUnits(stableInput, 6) : undefined;

  // previewBuy(amount, token)
  const { data: gldPreview } = useReadContract({
    ...exchange,
    functionName: "previewBuy",
    args: stableParsed ? [stableParsed, tokenAddress] : undefined,
    query: { enabled: !!stableParsed },
  });

  // Balance du token sélectionné
  const { data: tokenBalance } = useReadContract({
    address: tokenAddress,
    abi: ERC20_ABI,
    functionName: "balanceOf",
    args: address ? [address] : undefined,
    query: { enabled: !!address },
  });

  const gldAmount  = gldPreview !== undefined ? formatUnits(gldPreview as bigint, 3) : "—";
  const priceStr   = price !== undefined ? `$${(Number(price) / 1e8).toFixed(2)}` : "—";
  const balanceStr = tokenBalance !== undefined ? formatUnits(tokenBalance as bigint, 6) : "—";

  // Reset input quand on change de token
  const handleTokenChange = (t: StableToken) => {
    setSelectedToken(t);
    setStableInput("");
  };

  const handleBuy = async () => {
    if (!stableParsed || !address) return;
    try {
      setTxState("pending");
      setStep("approving");

      // Approve
      const approveTx = await writeContractAsync({
        address: tokenAddress,
        abi: ERC20_ABI,
        functionName: "approve",
        args: [exchange.address, stableParsed],
      });
      await waitForTransactionReceipt(wagmiConfig, { hash: approveTx });

      setStep("buying");
      setTxState("confirming");

      // buy(stableAmount, token)
      const buyTx = await writeContractAsync({
        ...exchange,
        functionName: "buy",
        args: [stableParsed, tokenAddress],
      });
      setTxHash(buyTx);
      setTxState("success");
      setStep("idle");
      setStableInput("");
    } catch {
      setTxState("error");
      setStep("idle");
    }
  };

  const isLoading = txState === "pending" || txState === "confirming";

  return (
    <div className="space-y-6">
      {/* Sélecteur USDC / EURC */}
      <div className="space-y-2">
        <Label>Stablecoin</Label>
        <TokenSelector value={selectedToken} onChange={handleTokenChange} />
      </div>

      {/* Input stablecoin */}
      <div className="space-y-2">
        <div className="flex items-center justify-between">
          <Label>{t("amount_usdc").replace("USDC", selectedToken)}</Label>
          <span className="text-xs text-muted-foreground">
            Solde : {balanceStr} {selectedToken}
          </span>
        </div>
        <div className="relative">
          <Input type="number" placeholder="0.00" value={stableInput}
            onChange={(e) => setStableInput(e.target.value)}
            className="pr-20 text-lg" min="0" />
          <span className="absolute right-3 top-1/2 -translate-y-1/2 text-sm font-medium text-muted-foreground">
            {selectedToken}
          </span>
        </div>
        <Button variant="ghost" size="sm" className="text-xs text-primary p-0 h-auto"
          onClick={() => setStableInput(balanceStr !== "—" ? balanceStr : "")}>
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
          <span className="text-2xl font-bold text-primary">{gldAmount}</span>
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
        <DetailRow label={t("price_source")}
          value={isOracle
            ? (priceSource === 0 ? "Chainlink + Tellor" : priceSource === 1 ? "Chainlink" : "Tellor")
            : t("fallback_price")} />
        {selectedToken === "EURC" && (
          <DetailRow
            label={`Taux EUR/USD${eurUsdLive ? "" : " (fallback)"}`}
            value={eurUsdStr}
          />
        )}
        <DetailRow label={t("fees")} value={feePercent} />
        <DetailRow label={t("step1")} value={step === "approving" ? t("step1_pending") : t("step1")} />
        <DetailRow label={t("step2")} value={step === "buying"   ? t("step2_pending") : t("step2")} />
      </div>

      <TxStatus state={txState} hash={txHash} />

      <Button className="w-full" size="lg"
        disabled={!stableInput || Number(stableInput) <= 0 || isLoading || !address}
        onClick={handleBuy}>
        {isLoading
          ? <><Loader2 className="h-4 w-4 mr-2 animate-spin" />En cours...</>
          : `${t("buy")} GLD avec ${selectedToken}`
        }
      </Button>
      {!address && <p className="text-center text-sm text-muted-foreground">{t("connect_to_buy")}</p>}
    </div>
  );
}

// ── Panneau Vente ─────────────────────────────────────────────────────────────
function SellPanel() {
  const t = useTranslations("trade");
  const { address } = useAccount();
  const { exchange, gld } = useContracts();
  const [gldInput, setGldInput]       = useState("");
  const [selectedToken, setSelectedToken] = useState<StableToken>("USDC");
  const [txHash, setTxHash]   = useState<`0x${string}` | undefined>();
  const [txState, setTxState] = useState<TxState>("idle");

  const { writeContractAsync } = useWriteContract();
  const { isLoading: isConfirming } = useWaitForTransactionReceipt({ hash: txHash });

  const tokenAddress = TOKEN_ADDRESS[selectedToken];

  const { data: feeBps } = useReadContract({ ...exchange, functionName: "feeBps" });
  const feePercent = feeBps !== undefined ? (Number(feeBps) / 100).toFixed(2) + "%" : "0%";

  // Prix — getPrice() retourne (uint256, uint8)
  const { data: priceRaw } = useReadContract({ ...exchange, functionName: "getPrice" });
  const priceData   = priceRaw as [bigint, number] | undefined;
  const price       = priceData?.[0];
  const priceSource = priceData?.[1] ?? 3;
  const isOracle    = priceSource <= 2;

  // Taux EUR/USD — getEurUsdRate() retourne (uint256, bool)
  const { data: eurUsdRaw } = useReadContract({
    ...exchange, functionName: "getEurUsdRate",
    query: { refetchInterval: 60_000 },
  });
  const eurUsdData  = eurUsdRaw as [bigint, boolean] | undefined;
  const eurUsdRate  = eurUsdData?.[0];
  const eurUsdLive  = eurUsdData?.[1] ?? false;
  const eurUsdStr   = eurUsdRate !== undefined
    ? `$${(Number(eurUsdRate) / 1e8).toFixed(4)}`
    : "—";

  const gldParsed = gldInput && Number(gldInput) > 0
    ? parseUnits(gldInput, 3) : undefined;

  // previewSell(gldAmount, token)
  const { data: stablePreview } = useReadContract({
    ...exchange,
    functionName: "previewSell",
    args: gldParsed ? [gldParsed, tokenAddress] : undefined,
    query: { enabled: !!gldParsed },
  });

  // Balance GLD
  const { data: gldBalance } = useReadContract({
    ...gld, functionName: "balanceOf",
    args: address ? [address] : undefined,
    query: { enabled: !!address },
  });

  const stableAmount = stablePreview !== undefined
    ? formatUnits(stablePreview as bigint, 6) : "—";
  const priceStr   = price !== undefined ? `$${(Number(price) / 1e8).toFixed(2)}` : "—";
  const balanceStr = gldBalance !== undefined ? formatUnits(gldBalance as bigint, 3) : "—";

  const handleSell = async () => {
    if (!gldParsed || !address) return;
    try {
      setTxState("pending");
      // sell(gldAmount, token) — pas d'approve GLD nécessaire (burn direct)
      const sellTx = await writeContractAsync({
        ...exchange,
        functionName: "sell",
        args: [gldParsed, tokenAddress],
      });
      setTxHash(sellTx);
      setTxState("success");
      setGldInput("");
    } catch {
      setTxState("error");
    }
  };

  const isLoading = txState === "pending" || txState === "confirming";

  return (
    <div className="space-y-6">
      {/* Sélecteur token de sortie */}
      <div className="space-y-2">
        <Label>Recevoir en</Label>
        <TokenSelector value={selectedToken} onChange={setSelectedToken} />
      </div>

      {/* Input GLD */}
      <div className="space-y-2">
        <div className="flex items-center justify-between">
          <Label>{t("amount_gld")}</Label>
          <span className="text-xs text-muted-foreground">Solde : {balanceStr} GLD</span>
        </div>
        <div className="relative">
          <Input type="number" placeholder="0.000" value={gldInput}
            onChange={(e) => setGldInput(e.target.value)}
            className="pr-16 text-lg" min="0" step="0.001" />
          <span className="absolute right-3 top-1/2 -translate-y-1/2 text-sm font-medium text-muted-foreground">GLD</span>
        </div>
        <Button variant="ghost" size="sm" className="text-xs text-primary p-0 h-auto"
          onClick={() => setGldInput(balanceStr !== "—" ? balanceStr : "")}>Max</Button>
      </div>

      {/* Flèche */}
      <div className="flex items-center justify-center">
        <div className="rounded-full border border-border bg-background p-2">
          <ArrowDownUp className="h-4 w-4 text-muted-foreground" />
        </div>
      </div>

      {/* Output stablecoin */}
      <div className="space-y-2">
        <Label>{t("you_receive")}</Label>
        <div className="rounded-lg border border-border bg-muted/30 p-4 flex items-center justify-between">
          <span className="text-2xl font-bold text-primary">{stableAmount}</span>
          <span className="text-sm font-medium text-muted-foreground">{selectedToken}</span>
        </div>
      </div>

      <Separator />

      <div className="space-y-2">
        <DetailRow label={t("price_per_gram")} value={priceStr} />
        <DetailRow label={t("price_source")}
          value={isOracle
            ? (priceSource === 0 ? "Chainlink + Tellor" : priceSource === 1 ? "Chainlink" : "Tellor")
            : t("fallback_price")} />
        {selectedToken === "EURC" && (
          <DetailRow
            label={`Taux EUR/USD${eurUsdLive ? "" : " (fallback)"}`}
            value={eurUsdStr}
          />
        )}
        <DetailRow label={t("fees")} value={feePercent} />
      </div>

      <TxStatus state={txState} hash={txHash} />

      <Button className="w-full" size="lg" variant="outline"
        disabled={!gldInput || Number(gldInput) <= 0 || isLoading || !address}
        onClick={handleSell}>
        {isLoading
          ? <><Loader2 className="h-4 w-4 mr-2 animate-spin" />En cours...</>
          : `${t("sell")} GLD → ${selectedToken}`
        }
      </Button>
      {!address && <p className="text-center text-sm text-muted-foreground">{t("connect_to_sell")}</p>}
    </div>
  );
}

// ── Panneau Cashback V3 ───────────────────────────────────────────────────────
// previewCashback retourne (address[], uint256[]) — une ligne par token
function CashbackPanel() {
  const { address } = useAccount();
  const { exchange } = useContracts();
  const [txHash, setTxHash]   = useState<`0x${string}` | undefined>();
  const [txState, setTxState] = useState<TxState>("idle");
  const { writeContractAsync } = useWriteContract();
  const { isLoading: isConfirming } = useWaitForTransactionReceipt({ hash: txHash });

  const { data: preview, refetch } = useReadContract({
    ...exchange,
    functionName: "previewCashback",
    args: address ? [address] : undefined,
    query: { enabled: !!address },
  });

  // (address[], uint256[])
  const [tokens, amounts] = (preview as [`0x${string}`[], bigint[]] | undefined) ?? [[], []];

  const totalCashback = amounts?.reduce((acc, v) => acc + v, 0n) ?? 0n;
  const hasAnyCashback = totalCashback > 0n;

  const handleClaimAll = async () => {
    try {
      setTxState("pending");
      const tx = await writeContractAsync({
        ...exchange, functionName: "claimAllCashback",
      });
      setTxState("confirming");
      setTxHash(tx);
      setTxState("success");
      refetch();
    } catch { setTxState("error"); }
  };

  const handleClaimOne = async (tokenAddr: `0x${string}`) => {
    try {
      setTxState("pending");
      const tx = await writeContractAsync({
        ...exchange, functionName: "claimCashback", args: [tokenAddr],
      });
      setTxState("confirming");
      setTxHash(tx);
      setTxState("success");
      refetch();
    } catch { setTxState("error"); }
  };

  const isLoading = txState === "pending" || txState === "confirming" || isConfirming;

  if (!address || !hasAnyCashback) return null;

  const getSymbol = (addr: string) => {
    if (addr.toLowerCase() === USDC_ADDRESS.toLowerCase()) return "USDC";
    if (addr.toLowerCase() === EURC_ADDRESS.toLowerCase()) return "EURC";
    return addr.slice(0, 6) + "...";
  };

  return (
    <div className="rounded-xl border border-border bg-card p-6 space-y-4">
      <div className="flex items-center gap-2">
        <span className="text-lg">🎁</span>
        <h3 className="font-semibold">Cashback disponible</h3>
        <Badge variant="default" className="text-xs">Éligible</Badge>
      </div>
      <Separator />

      {tokens?.map((tokenAddr, i) => {
        const amount = amounts?.[i] ?? 0n;
        if (amount === 0n) return null;
        const symbol = getSymbol(tokenAddr);
        return (
          <div key={tokenAddr} className="flex items-center justify-between">
            <div>
              <p className="text-sm font-medium">{symbol}</p>
              <p className="text-xs text-muted-foreground">
                {parseFloat(formatUnits(amount, 6)).toFixed(4)} {symbol}
              </p>
            </div>
            <Button size="sm" variant="outline"
              disabled={isLoading}
              onClick={() => handleClaimOne(tokenAddr)}>
              Réclamer
            </Button>
          </div>
        );
      })}

      <TxStatus state={txState} hash={txHash} />

      {tokens && tokens.length > 1 && hasAnyCashback && (
        <Button className="w-full" disabled={isLoading} onClick={handleClaimAll}>
          {isLoading
            ? <><Loader2 className="h-4 w-4 mr-2 animate-spin" />En cours...</>
            : "Tout réclamer (USDC + EURC)"
          }
        </Button>
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
    ...exchange, functionName: "paused",
  });

  if (!mounted) return null;

  return (
    <div className="max-w-lg mx-auto space-y-6">
      <div className="text-center space-y-2">
        <div className="flex items-center justify-center gap-2">
          <TrendingUp className="h-6 w-6 text-primary" />
          <h1 className="text-3xl font-bold">{t("title")}</h1>
        </div>
        <p className="text-muted-foreground text-sm">{t("subtitle")}</p>
        {exchangePaused && <Badge variant="destructive">Exchange pausé</Badge>}
      </div>

      <div className="rounded-xl border border-border bg-card p-6 shadow-sm">
        <Tabs defaultValue="buy">
          <TabsList className="w-full mb-6">
            <TabsTrigger value="buy"  className="flex-1">{t("buy")}</TabsTrigger>
            <TabsTrigger value="sell" className="flex-1">{t("sell")}</TabsTrigger>
          </TabsList>
          <TabsContent value="buy">  <BuyPanel />  </TabsContent>
          <TabsContent value="sell"> <SellPanel /> </TabsContent>
        </Tabs>
      </div>

      <CashbackPanel />

      <p className="text-center text-xs text-muted-foreground px-4">{t("irreversible_trade")}</p>
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

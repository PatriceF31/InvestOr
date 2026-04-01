import type { GetStaticPropsContext } from "next";
import { useState, useEffect } from "react";
import { useTranslations } from "next-intl";
import { useAccount, useReadContract, useWriteContract, useWaitForTransactionReceipt } from "wagmi";
import { formatUnits, parseUnits } from "viem";
import { useContracts } from "@/hooks/useContracts";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Separator } from "@/components/ui/separator";
import { Wallet, ArrowDownToLine, ArrowUpFromLine, Loader2, CheckCircle2, AlertCircle } from "lucide-react";

function TxStatus({ isPending, isConfirming, isConfirmed, isError, hash }: {
  isPending: boolean; isConfirming: boolean;
  isConfirmed: boolean; isError: boolean;
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
      {isError     && <AlertCircle  className="h-4 w-4 mt-0.5 text-destructive shrink-0" />}
      <div>
        <p className="font-medium">
          {isPending    && "Confirmez dans votre portefeuille..."}
          {isConfirming && "Transaction en cours..."}
          {isConfirmed  && "Transaction réussie !"}
          {isError      && "Erreur de transaction"}
        </p>
        {hash && <p className="text-xs text-muted-foreground font-mono mt-1">{hash.slice(0,10)}...{hash.slice(-8)}</p>}
      </div>
    </div>
  );
}

// ── Panneau Dépôt ─────────────────────────────────────────────────────────────
function DepositPanel() {
  const t = useTranslations("deposit");
  const { address } = useAccount();
  const { treasury } = useContracts();
  const [amount, setAmount] = useState("");
  const [txHash, setTxHash] = useState<`0x${string}` | undefined>();

  const { writeContractAsync, isPending, isError } = useWriteContract();
  const { isLoading: isConfirming, isSuccess: isConfirmed } =
    useWaitForTransactionReceipt({ hash: txHash });

  // Adresse USDC
  const { data: usdcAddress } = useReadContract({
    ...treasury, functionName: "usdc",
  });

  // Balance USDC wallet
  const { data: walletBalance } = useReadContract({
    address: usdcAddress as `0x${string}` | undefined,
    abi: [{ name: "balanceOf", type: "function", stateMutability: "view",
      inputs: [{ name: "a", type: "address" }], outputs: [{ type: "uint256" }] }] as const,
    functionName: "balanceOf",
    args: address ? [address] : undefined,
    query: { enabled: !!address && !!usdcAddress },
  });

  // Balance USDC dans Treasury
  const { data: treasuryBalance } = useReadContract({
    ...treasury, functionName: "balanceOf",
    args: address ? [address] : undefined,
    query: { enabled: !!address },
  });

  const walletStr   = walletBalance   !== undefined ? formatUnits(walletBalance   as bigint, 6) : "—";
  const treasuryStr = treasuryBalance !== undefined ? formatUnits(treasuryBalance as bigint, 6) : "—";

  const handleDeposit = async () => {
    if (!amount || !usdcAddress || !address) return;
    const parsed = parseUnits(amount, 6);
    try {
      // 1. Approve
      await writeContractAsync({
        address: usdcAddress as `0x${string}`,
        abi: [{ name: "approve", type: "function", stateMutability: "nonpayable",
          inputs: [{ name: "s", type: "address" }, { name: "a", type: "uint256" }],
          outputs: [{ type: "bool" }] }] as const,
        functionName: "approve",
        args: [treasury.address, parsed],
      });
      // 2. Deposit
      const tx = await writeContractAsync({
        ...treasury, functionName: "deposit", args: [parsed],
      });
      setTxHash(tx);
      setAmount("");
    } catch {}
  };

  const isLoading = isPending || isConfirming;

  return (
    <div className="space-y-6">
      <div className="grid grid-cols-2 gap-4">
        <div className="rounded-lg border border-border bg-card/50 p-4 space-y-1">
          <p className="text-xs text-muted-foreground flex items-center gap-1">
            <Wallet className="h-3 w-3" /> Votre wallet
          </p>
          <p className="text-lg font-semibold">{walletStr} USDC</p>
        </div>
        <div className="rounded-lg border border-primary/30 bg-primary/5 p-4 space-y-1">
          <p className="text-xs text-muted-foreground flex items-center gap-1">
            <ArrowDownToLine className="h-3 w-3" /> {t("treasury_balance")}
          </p>
          <p className="text-lg font-semibold text-primary">{treasuryStr} USDC</p>
        </div>
      </div>

      <div className="space-y-2">
        <div className="flex items-center justify-between">
          <Label>{t("amount")}</Label>
          <Button variant="ghost" size="sm" className="text-xs text-primary p-0 h-auto"
            onClick={() => setAmount(walletStr !== "—" ? walletStr : "")}>Max</Button>
        </div>
        <div className="relative">
          <Input type="number" placeholder="0.00" value={amount}
            onChange={e => setAmount(e.target.value)} className="pr-16 text-lg" min="0" />
          <span className="absolute right-3 top-1/2 -translate-y-1/2 text-sm font-medium text-muted-foreground">USDC</span>
        </div>
      </div>

      <TxStatus isPending={isPending} isConfirming={isConfirming}
        isConfirmed={isConfirmed} isError={isError} hash={txHash} />

      <Button className="w-full" size="lg"
        disabled={!amount || Number(amount) <= 0 || isLoading || !address}
        onClick={handleDeposit}>
        {isLoading
          ? <><Loader2 className="h-4 w-4 mr-2 animate-spin" />En cours...</>
          : <><ArrowDownToLine className="h-4 w-4 mr-2" />{t("deposit")}</>
        }
      </Button>
    </div>
  );
}

// ── Panneau Retrait ────────────────────────────────────────────────────────────
function WithdrawPanel() {
  const t = useTranslations("deposit");
  const { address } = useAccount();
  const { treasury } = useContracts();
  const [amount, setAmount] = useState("");
  const [txHash, setTxHash] = useState<`0x${string}` | undefined>();

  const { writeContractAsync, isPending, isError } = useWriteContract();
  const { isLoading: isConfirming, isSuccess: isConfirmed } =
    useWaitForTransactionReceipt({ hash: txHash });

  const { data: treasuryBalance } = useReadContract({
    ...treasury, functionName: "balanceOf",
    args: address ? [address] : undefined,
    query: { enabled: !!address },
  });

  const treasuryStr = treasuryBalance !== undefined
    ? formatUnits(treasuryBalance as bigint, 6) : "—";

  const handleWithdraw = async () => {
    if (!amount || !address) return;
    const parsed = parseUnits(amount, 6);
    try {
      const tx = await writeContractAsync({
        ...treasury, functionName: "withdraw", args: [parsed],
      });
      setTxHash(tx);
      setAmount("");
    } catch {}
  };

  const isLoading = isPending || isConfirming;

  return (
    <div className="space-y-6">
      <div className="rounded-lg border border-primary/30 bg-primary/5 p-4 space-y-1">
        <p className="text-xs text-muted-foreground">{t("treasury_balance")}</p>
        <p className="text-2xl font-bold text-primary">{treasuryStr} USDC</p>
        <p className="text-xs text-muted-foreground">disponible au retrait</p>
      </div>

      <div className="space-y-2">
        <div className="flex items-center justify-between">
          <Label>{t("amount")}</Label>
          <Button variant="ghost" size="sm" className="text-xs text-primary p-0 h-auto"
            onClick={() => setAmount(treasuryStr !== "—" ? treasuryStr : "")}>Max</Button>
        </div>
        <div className="relative">
          <Input type="number" placeholder="0.00" value={amount}
            onChange={e => setAmount(e.target.value)} className="pr-16 text-lg" min="0" />
          <span className="absolute right-3 top-1/2 -translate-y-1/2 text-sm font-medium text-muted-foreground">USDC</span>
        </div>
      </div>

      <TxStatus isPending={isPending} isConfirming={isConfirming}
        isConfirmed={isConfirmed} isError={isError} hash={txHash} />

      <Button className="w-full" size="lg" variant="outline"
        disabled={!amount || Number(amount) <= 0 || isLoading || !address}
        onClick={handleWithdraw}>
        {isLoading
          ? <><Loader2 className="h-4 w-4 mr-2 animate-spin" />En cours...</>
          : <><ArrowUpFromLine className="h-4 w-4 mr-2" />{t("withdraw")}</>
        }
      </Button>
    </div>
  );
}

// ── Page Deposit ──────────────────────────────────────────────────────────────
export default function DepositPage() {
  const t = useTranslations("deposit");
  const { treasury } = useContracts();
  const [mounted, setMounted] = useState(false);
  useEffect(() => { setMounted(true); }, []);

  const { data: totalDeposited } = useReadContract({
    ...treasury, functionName: "totalDeposited",
  });

  if (!mounted) return null;

  return (
    <div className="max-w-lg mx-auto space-y-6">
      <div className="text-center space-y-2">
        <div className="flex items-center justify-center gap-2">
          <Wallet className="h-6 w-6 text-primary" />
          <h1 className="text-3xl font-bold">{t("title")}</h1>
        </div>
        <p className="text-muted-foreground text-sm">
          Total en réserve :{" "}
          <span className="font-semibold text-foreground">
            {totalDeposited !== undefined
              ? `${formatUnits(totalDeposited as bigint, 6)} USDC`
              : "—"
            }
          </span>
        </p>
      </div>

      <div className="rounded-xl border border-border bg-card p-6 shadow-sm">
        <Tabs defaultValue="deposit">
          <TabsList className="w-full mb-6">
            <TabsTrigger value="deposit"  className="flex-1 gap-2">
              <ArrowDownToLine className="h-4 w-4" />{t("deposit")}
            </TabsTrigger>
            <TabsTrigger value="withdraw" className="flex-1 gap-2">
              <ArrowUpFromLine className="h-4 w-4" />{t("withdraw")}
            </TabsTrigger>
          </TabsList>
          <TabsContent value="deposit">  <DepositPanel />  </TabsContent>
          <TabsContent value="withdraw"> <WithdrawPanel /> </TabsContent>
        </Tabs>
      </div>

      <Separator />

      <div className="text-center text-xs text-muted-foreground space-y-1">
        <p>Les USDC déposés sont utilisés comme collatéral pour les tokens GLD.</p>
        <p>Vous pouvez retirer vos USDC à tout moment (hors pause d'urgence).</p>
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

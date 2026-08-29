import { useCallback } from "react";
import { useAccount, useReadContracts, useWriteContract } from "wagmi";
import { waitForTransactionReceipt } from "wagmi/actions";
import { formatUnits, parseUnits } from "viem";
import { useContracts } from "./useContracts";
import { wagmiConfig } from "@/lib/wagmi.config";

// Adresse stablecoin Sepolia (loanToken du vault) — même constante que useTrade.ts/useDashboard.ts
const USDC_ADDRESS = "0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238" as const;

const ERC20_ABI = [
  { name: "balanceOf", type: "function", stateMutability: "view",
    inputs: [{ name: "account", type: "address" }], outputs: [{ type: "uint256" }] },
  { name: "approve", type: "function", stateMutability: "nonpayable",
    inputs: [{ name: "spender", type: "address" }, { name: "amount", type: "uint256" }],
    outputs: [{ type: "bool" }] },
] as const;

export type LombardHealth = "none" | "safe" | "warning" | "danger";

// GLD = 3 décimales (collatéral), USDC = 6 décimales (emprunt / pool prêteurs)
const GLD_DECIMALS = 3;
const USDC_DECIMALS = 6;

/**
 * Hook pour le Prêt Lombard (LombardVault.sol) — US-01 (emprunteur, Marthe) /
 * US-13 (prêteur, Farid).
 *
 * ⚠️ Contrairement à Exchange/Treasury, LombardVault ne journalise rien dans
 * EventLogger (cf. Annexe 09 §6 — gap identifié, non corrigé dans cette version).
 * Toute vue "activité récente" doit lire les events natifs du contrat
 * (CollateralDeposited, Borrowed, Repaid, CollateralWithdrawn, Supplied,
 * SupplyWithdrawn, RewardClaimed, Liquidated) via getLogs, pas EventLogger.
 *
 * ⚠️ Point de déploiement (backend, pas frontend) : LombardVault doit être
 * enregistré comme identité *vérifiée* dans IdentityRegistry, jamais comme
 * agent CountryComplianceModule. Si ce n'est pas fait pour l'utilisateur
 * connecté, depositCollateral() revert côté GLD (transfert non conforme) —
 * voir handleContractError ci-dessous pour un message utilisateur adapté.
 */
export function useLombard() {
  const { address } = useAccount();
  const { lombardVault, gld } = useContracts();
  const { writeContractAsync } = useWriteContract();

  // ── Paramètres du protocole + état du pool ───────────────────────────────
  const { data: poolData, isLoading: isPoolLoading, refetch: refetchPool } = useReadContracts({
    contracts: [
      { ...lombardVault, functionName: "ltvMaxBps" },               // 0
      { ...lombardVault, functionName: "liquidationThresholdBps" }, // 1
      { ...lombardVault, functionName: "liquidationDiscountBps" },  // 2
      { ...lombardVault, functionName: "borrowRateBps" },           // 3
      { ...lombardVault, functionName: "supplierShareBps" },        // 4
      { ...lombardVault, functionName: "protocolShareBps" },        // 5
      { ...lombardVault, functionName: "availableLiquidity" },      // 6
      { ...lombardVault, functionName: "totalSupplied" },           // 7
      { ...lombardVault, functionName: "paused" },                  // 8
    ],
    query: { refetchInterval: 30_000 },
  });

  const ltvMaxBps               = poolData?.[0]?.result as bigint | undefined;
  const liquidationThresholdBps = poolData?.[1]?.result as bigint | undefined;
  const liquidationDiscountBps  = poolData?.[2]?.result as bigint | undefined;
  const borrowRateBps           = poolData?.[3]?.result as bigint | undefined;
  const supplierShareBps        = poolData?.[4]?.result as bigint | undefined;
  const protocolShareBps        = poolData?.[5]?.result as bigint | undefined;
  const availableLiquidity      = poolData?.[6]?.result as bigint | undefined;
  const totalSupplied           = poolData?.[7]?.result as bigint | undefined;
  const isPaused                = (poolData?.[8]?.result as boolean | undefined) ?? false;

  // ── Position de l'utilisateur connecté (emprunteur + prêteur) ────────────
  const { data: userData, isLoading: isUserLoading, refetch: refetchUser } = useReadContracts({
    contracts: [
      { ...lombardVault, functionName: "positions",         args: address ? [address] : undefined }, // 0
      { ...lombardVault, functionName: "debtOf",             args: address ? [address] : undefined }, // 1
      { ...lombardVault, functionName: "currentLTV",         args: address ? [address] : undefined }, // 2
      { ...lombardVault, functionName: "supplierPrincipal",  args: address ? [address] : undefined }, // 3
      { ...lombardVault, functionName: "pendingReward",      args: address ? [address] : undefined }, // 4
      { ...gld,           functionName: "balanceOf",         args: address ? [address] : undefined }, // 5
      { ...gld,           functionName: "allowance",         args: address ? [address, lombardVault.address] : undefined }, // 6
      { address: USDC_ADDRESS, abi: ERC20_ABI, functionName: "balanceOf", args: address ? [address] : undefined }, // 7
    ],
    query: { enabled: !!address, refetchInterval: 15_000 },
  });

  const positions = userData?.[0]?.result as readonly [bigint, bigint, bigint, bigint] | undefined;
  const collateralGLD = positions?.[0];

  // debtOf() recalcule l'intérêt couru en direct — plus fiable pour l'affichage
  // que positions().interestOwed, qui n'est mis à jour qu'à la prochaine interaction.
  const debt = userData?.[1]?.result as readonly [bigint, bigint] | undefined;
  const debtPrincipal = debt?.[0];
  const debtInterest  = debt?.[1];
  const totalDebt = debtPrincipal !== undefined && debtInterest !== undefined
    ? debtPrincipal + debtInterest : undefined;

  // currentLTV() retourne type(uint256).max si collatéral nul avec dette résiduelle
  const rawLtv = userData?.[2]?.result as bigint | undefined;
  const UINT_MAX = (1n << 256n) - 1n;
  const currentLtvBps = rawLtv !== undefined && rawLtv >= UINT_MAX / 2n ? undefined : rawLtv;

  const supplierPrincipal = userData?.[3]?.result as bigint | undefined;
  const pendingReward     = userData?.[4]?.result as bigint | undefined;
  const gldBalance        = userData?.[5]?.result as bigint | undefined;
  const gldAllowance      = userData?.[6]?.result as bigint | undefined;
  const usdcBalance       = userData?.[7]?.result as bigint | undefined;

  // ── Santé de la position emprunteur ──────────────────────────────────────
  const health: LombardHealth = (() => {
    if (!totalDebt || totalDebt === 0n) return "none";
    if (currentLtvBps === undefined || liquidationThresholdBps === undefined) return "none";
    if (currentLtvBps >= liquidationThresholdBps) return "danger";
    // "warning" dès 90 % du seuil de liquidation
    if (currentLtvBps * 100n >= liquidationThresholdBps * 90n) return "warning";
    return "safe";
  })();

  const bpsToPercent = (v?: bigint) => v !== undefined ? (Number(v) / 100).toFixed(2) + "%" : "—";

  // ── Écritures — Emprunteur (US-01) ───────────────────────────────────────

  const depositCollateral = useCallback(async (amount: string) => {
    if (!address) throw new Error("Wallet non connecté");
    const parsed = parseUnits(amount, GLD_DECIMALS);

    const approveTx = await writeContractAsync({
      ...gld, functionName: "approve", args: [lombardVault.address, parsed],
    });
    await waitForTransactionReceipt(wagmiConfig, { hash: approveTx });

    return writeContractAsync({
      ...lombardVault, functionName: "depositCollateral", args: [parsed],
    });
  }, [address, gld, lombardVault, writeContractAsync]);

  const withdrawCollateral = useCallback(async (amount: string) => {
    if (!address) throw new Error("Wallet non connecté");
    const parsed = parseUnits(amount, GLD_DECIMALS);
    return writeContractAsync({
      ...lombardVault, functionName: "withdrawCollateral", args: [parsed],
    });
  }, [address, lombardVault, writeContractAsync]);

  const borrow = useCallback(async (amount: string) => {
    if (!address) throw new Error("Wallet non connecté");
    const parsed = parseUnits(amount, USDC_DECIMALS);
    return writeContractAsync({
      ...lombardVault, functionName: "borrow", args: [parsed],
    });
  }, [address, lombardVault, writeContractAsync]);

  const repay = useCallback(async (amount: string) => {
    if (!address) throw new Error("Wallet non connecté");
    const parsed = parseUnits(amount, USDC_DECIMALS);

    const approveTx = await writeContractAsync({
      address: USDC_ADDRESS, abi: ERC20_ABI, functionName: "approve",
      args: [lombardVault.address, parsed],
    });
    await waitForTransactionReceipt(wagmiConfig, { hash: approveTx });

    return writeContractAsync({
      ...lombardVault, functionName: "repay", args: [parsed],
    });
  }, [address, lombardVault, writeContractAsync]);

  // ── Écritures — Prêteur (US-13) ──────────────────────────────────────────

  const supply = useCallback(async (amount: string) => {
    if (!address) throw new Error("Wallet non connecté");
    const parsed = parseUnits(amount, USDC_DECIMALS);

    const approveTx = await writeContractAsync({
      address: USDC_ADDRESS, abi: ERC20_ABI, functionName: "approve",
      args: [lombardVault.address, parsed],
    });
    await waitForTransactionReceipt(wagmiConfig, { hash: approveTx });

    return writeContractAsync({
      ...lombardVault, functionName: "supply", args: [parsed],
    });
  }, [address, lombardVault, writeContractAsync]);

  // Retrait "best effort" côté prêteur — peut renvoyer moins que demandé si la
  // liquidité du pool est insuffisante (même pattern que MorphoYieldStrategy).
  const withdraw = useCallback(async (amount: string) => {
    if (!address) throw new Error("Wallet non connecté");
    const parsed = parseUnits(amount, USDC_DECIMALS);
    return writeContractAsync({
      ...lombardVault, functionName: "withdraw", args: [parsed],
    });
  }, [address, lombardVault, writeContractAsync]);

  const claimReward = useCallback(async () => {
    if (!address) throw new Error("Wallet non connecté");
    return writeContractAsync({ ...lombardVault, functionName: "claimReward" });
  }, [address, lombardVault, writeContractAsync]);

  const refetch = useCallback(() => {
    refetchPool();
    refetchUser();
  }, [refetchPool, refetchUser]);

  return {
    // Paramètres protocole (bruts + formatés)
    params: {
      ltvMaxBps, liquidationThresholdBps, liquidationDiscountBps,
      borrowRateBps, supplierShareBps, protocolShareBps,
      ltvMaxPercent: bpsToPercent(ltvMaxBps),
      liquidationThresholdPercent: bpsToPercent(liquidationThresholdBps),
      liquidationDiscountPercent: bpsToPercent(liquidationDiscountBps),
      borrowRatePercent: bpsToPercent(borrowRateBps),
      supplierSharePercent: bpsToPercent(supplierShareBps),
    },

    // État du pool
    pool: {
      availableLiquidity, totalSupplied, isPaused,
      availableLiquidityFormatted: availableLiquidity !== undefined
        ? formatUnits(availableLiquidity, USDC_DECIMALS) : "—",
      totalSuppliedFormatted: totalSupplied !== undefined
        ? formatUnits(totalSupplied, USDC_DECIMALS) : "—",
    },

    // Position emprunteur de l'utilisateur connecté
    position: {
      collateralGLD, debtPrincipal, debtInterest, totalDebt, currentLtvBps, health,
      collateralFormatted: collateralGLD !== undefined ? formatUnits(collateralGLD, GLD_DECIMALS) : "—",
      debtFormatted: totalDebt !== undefined ? formatUnits(totalDebt, USDC_DECIMALS) : "—",
      currentLtvPercent: currentLtvBps !== undefined ? bpsToPercent(currentLtvBps) : "∞",
    },

    // Position prêteur de l'utilisateur connecté
    lending: {
      supplierPrincipal, pendingReward,
      supplierPrincipalFormatted: supplierPrincipal !== undefined ? formatUnits(supplierPrincipal, USDC_DECIMALS) : "—",
      pendingRewardFormatted: pendingReward !== undefined ? formatUnits(pendingReward, USDC_DECIMALS) : "—",
    },

    // Soldes wallet + allowance GLD déjà accordée au vault
    wallet: {
      gldBalance, usdcBalance, gldAllowance,
      gldBalanceFormatted: gldBalance !== undefined ? formatUnits(gldBalance, GLD_DECIMALS) : "—",
      usdcBalanceFormatted: usdcBalance !== undefined ? formatUnits(usdcBalance, USDC_DECIMALS) : "—",
    },

    // Actions
    depositCollateral, withdrawCollateral, borrow, repay,
    supply, withdraw, claimReward,

    isLoading: isPoolLoading || isUserLoading,
    refetch,
  };
}

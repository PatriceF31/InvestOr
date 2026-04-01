import { useState, useCallback } from "react";
import { useReadContract, useWriteContract, useWaitForTransactionReceipt, useAccount } from "wagmi";
import { parseUnits, formatUnits } from "viem";
import { useContracts } from "./useContracts";

/**
 * Hook pour l'achat et la vente de GLD
 * Gère : approve USDC → buy / sell → confirmation tx
 */
export function useTrade() {
  const { address } = useAccount();
  const { gld, treasury, exchange } = useContracts();
  const [txHash, setTxHash] = useState<`0x${string}` | undefined>();

  const { writeContractAsync, isPending } = useWriteContract();

  const { isLoading: isConfirming, isSuccess: isConfirmed } =
    useWaitForTransactionReceipt({ hash: txHash });

  // ── Prix actuel ──────────────────────────────────────────────────────────
  const { data: priceData } = useReadContract({
    ...exchange,
    functionName: "getPrice",
  });

  const price    = (priceData as [bigint, boolean] | undefined)?.[0];
  const isOracle = (priceData as [bigint, boolean] | undefined)?.[1] ?? false;

  // ── Preview achat ─────────────────────────────────────────────────────────
  const usePreviewBuy = (usdcAmount: string) => {
    const parsed = usdcAmount && Number(usdcAmount) > 0
      ? parseUnits(usdcAmount, 6)
      : undefined;

    const { data } = useReadContract({
      ...exchange,
      functionName: "previewBuy",
      args: parsed ? [parsed] : undefined,
      query: { enabled: !!parsed },
    });

    return data as bigint | undefined;
  };

  // ── Preview vente ─────────────────────────────────────────────────────────
  const usePreviewSell = (gldAmount: string) => {
    const parsed = gldAmount && Number(gldAmount) > 0
      ? parseUnits(gldAmount, 3)
      : undefined;

    const { data } = useReadContract({
      ...exchange,
      functionName: "previewSell",
      args: parsed ? [parsed] : undefined,
      query: { enabled: !!parsed },
    });

    return data as bigint | undefined;
  };

  // ── Allowance USDC pour Exchange ──────────────────────────────────────────
  const useUsdcAllowance = () => {
    const { data } = useReadContract({
      address: treasury.address,
      abi: [
        {
          name: "usdc",
          type: "function",
          stateMutability: "view",
          inputs: [],
          outputs: [{ type: "address" }],
        },
      ] as const,
      functionName: "usdc",
    });
    return data as `0x${string}` | undefined;
  };

  // ── Achat : approve + buy ─────────────────────────────────────────────────
  const buy = useCallback(async (usdcAmount: string, usdcAddress: `0x${string}`) => {
    if (!address) throw new Error("Wallet non connecté");
    const amount = parseUnits(usdcAmount, 6);

    // 1. Approve USDC vers Exchange
    const approveTx = await writeContractAsync({
      address: usdcAddress,
      abi: [{
        name: "approve",
        type: "function",
        stateMutability: "nonpayable",
        inputs: [
          { name: "spender", type: "address" },
          { name: "amount",  type: "uint256" },
        ],
        outputs: [{ type: "bool" }],
      }] as const,
      functionName: "approve",
      args: [exchange.address, amount],
    });
    setTxHash(approveTx);

    // 2. Buy
    const buyTx = await writeContractAsync({
      ...exchange,
      functionName: "buy",
      args: [amount],
    });
    setTxHash(buyTx);
    return buyTx;
  }, [address, exchange, writeContractAsync]);

  // ── Vente : sell ──────────────────────────────────────────────────────────
  const sell = useCallback(async (gldAmount: string) => {
    if (!address) throw new Error("Wallet non connecté");
    const amount = parseUnits(gldAmount, 3);

    const sellTx = await writeContractAsync({
      ...exchange,
      functionName: "sell",
      args: [amount],
    });
    setTxHash(sellTx);
    return sellTx;
  }, [address, exchange, writeContractAsync]);

  return {
    price,
    isOracle,
    priceFormatted: price ? `$${(Number(price) / 1e8).toFixed(2)}` : "—",
    buy,
    sell,
    usePreviewBuy,
    usePreviewSell,
    useUsdcAllowance,
    isPending,
    isConfirming,
    isConfirmed,
    txHash,
  };
}

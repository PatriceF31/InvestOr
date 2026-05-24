import { useState, useCallback } from "react";
import { useReadContract, useWriteContract, useWaitForTransactionReceipt, useAccount } from "wagmi";
import { parseUnits } from "viem";
import { useContracts } from "./useContracts";

// Adresses stablecoins Sepolia
const USDC_ADDRESS = "0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238" as const;
const EURC_ADDRESS = "0x08210F9170F89Ab7658F0B5E3fF39b0E03C594D4" as const;

export type StableToken = "USDC" | "EURC";
export const TOKEN_ADDRESS: Record<StableToken, `0x${string}`> = {
  USDC: USDC_ADDRESS,
  EURC: EURC_ADDRESS,
};

/**
 * Hook pour l'achat et la vente de GLD — V3 multi-token
 * Corrections V3 :
 *   - getPrice() retourne (uint256, uint8) — source pas bool
 *   - previewBuy(amount, token) / previewSell(amount, token)
 *   - buy(amount, token) / sell(amount, token)
 */
export function useTrade() {
  const { address } = useAccount();
  const { exchange } = useContracts();
  const [txHash, setTxHash] = useState<`0x${string}` | undefined>();

  const { writeContractAsync, isPending } = useWriteContract();

  const { isLoading: isConfirming, isSuccess: isConfirmed } =
    useWaitForTransactionReceipt({ hash: txHash });

  // ── Prix actuel — getPrice() V3 : (uint256, uint8) ───────────────────────
  const { data: priceData } = useReadContract({
    ...exchange,
    functionName: "getPrice",
  });

  // source: 0=médiane CL+TL, 1=Chainlink, 2=Tellor, 3=fallback
  const price       = (priceData as [bigint, number] | undefined)?.[0];
  const priceSource = (priceData as [bigint, number] | undefined)?.[1] ?? 3;
  const isOracle    = priceSource <= 2;

  // ── Preview achat — previewBuy(amount, token) ─────────────────────────────
  const usePreviewBuy = (stableAmount: string, token: StableToken = "USDC") => {
    const tokenAddress = TOKEN_ADDRESS[token];
    const parsed = stableAmount && Number(stableAmount) > 0
      ? parseUnits(stableAmount, 6)
      : undefined;

    const { data } = useReadContract({
      ...exchange,
      functionName: "previewBuy",
      args: parsed ? [parsed, tokenAddress] : undefined,
      query: { enabled: !!parsed },
    });

    return data as bigint | undefined;
  };

  // ── Preview vente — previewSell(amount, token) ────────────────────────────
  const usePreviewSell = (gldAmount: string, token: StableToken = "USDC") => {
    const tokenAddress = TOKEN_ADDRESS[token];
    const parsed = gldAmount && Number(gldAmount) > 0
      ? parseUnits(gldAmount, 3)
      : undefined;

    const { data } = useReadContract({
      ...exchange,
      functionName: "previewSell",
      args: parsed ? [parsed, tokenAddress] : undefined,
      query: { enabled: !!parsed },
    });

    return data as bigint | undefined;
  };

  // ── Achat : approve + buy(amount, token) ──────────────────────────────────
  const buy = useCallback(async (
    stableAmount: string,
    token: StableToken = "USDC"
  ) => {
    if (!address) throw new Error("Wallet non connecté");
    const tokenAddress = TOKEN_ADDRESS[token];
    const amount = parseUnits(stableAmount, 6);

    // 1. Approve token vers Exchange
    const approveTx = await writeContractAsync({
      address: tokenAddress,
      abi: [{
        name: "approve", type: "function", stateMutability: "nonpayable",
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

    // 2. buy(stableAmount, token)
    const buyTx = await writeContractAsync({
      ...exchange,
      functionName: "buy",
      args: [amount, tokenAddress],
    });
    setTxHash(buyTx);
    return buyTx;
  }, [address, exchange, writeContractAsync]);

  // ── Vente : sell(amount, token) ───────────────────────────────────────────
  const sell = useCallback(async (
    gldAmount: string,
    token: StableToken = "USDC"
  ) => {
    if (!address) throw new Error("Wallet non connecté");
    const tokenAddress = TOKEN_ADDRESS[token];
    const amount = parseUnits(gldAmount, 3);

    const sellTx = await writeContractAsync({
      ...exchange,
      functionName: "sell",
      args: [amount, tokenAddress],
    });
    setTxHash(sellTx);
    return sellTx;
  }, [address, exchange, writeContractAsync]);

  return {
    price,
    priceSource,
    isOracle,
    priceFormatted: price ? `$${(Number(price) / 1e8).toFixed(2)}` : "—",
    buy,
    sell,
    usePreviewBuy,
    usePreviewSell,
    isPending,
    isConfirming,
    isConfirmed,
    txHash,
  };
}

import { useReadContracts } from "wagmi";
import { useAccount } from "wagmi";
import { useContracts } from "./useContracts";
import { formatUnits } from "viem";

// Adresses stablecoins Sepolia
const USDC_SEPOLIA = "0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238";
const EURC_SEPOLIA = "0x08210F9170F89Ab7658F0B5E3fF39b0E03C594D4";

const ERC20_BALANCE_ABI = [{
  name: "balanceOf", type: "function", stateMutability: "view",
  inputs: [{ name: "account", type: "address" }],
  outputs: [{ name: "", type: "uint256" }],
}] as const;

/**
 * Agrège toutes les données du Dashboard en un seul appel multicall.
 * Retourne les données formatées et prêtes à l'affichage.
 *
 * Corrections V3 :
 *   - getPrice() retourne (uint256, uint8) — source est un uint8 (0=médiane, 1=CL, 2=TL, 3=fallback)
 *   - totalDeposited() agrège USDC + EURC
 *   - Ajout balance EURC wallet
 */
export function useDashboard() {
  const { address } = useAccount();
  const { gld, treasury, exchange, reserve } = useContracts();

  const { data, isLoading, isError, refetch } = useReadContracts({
    contracts: [
      // 0 — Balance GLD de l'utilisateur
      { ...gld, functionName: "balanceOf", args: address ? [address] : undefined },
      // 1 — Total supply GLD
      { ...gld, functionName: "totalSupply" },
      // 2 — Balance USDC wallet
      {
        address: USDC_SEPOLIA,
        abi: ERC20_BALANCE_ABI,
        functionName: "balanceOf",
        args: address ? [address] : undefined,
      },
      // 3 — Total déposé Treasury (USDC + EURC agrégés)
      { ...treasury, functionName: "totalDeposited" },
      // 4 — Prix or — getPrice() retourne (uint256 price, uint8 source)
      { ...exchange, functionName: "getPrice" },
      // 5 — État complet de la réserve
      { ...reserve, functionName: "getReserveStatus" },
      // 6 — Mode V2 : adresse lingotOr
      { ...reserve, functionName: "lingotOr" },
      // 7 — Balance EURC wallet
      {
        address: EURC_SEPOLIA,
        abi: ERC20_BALANCE_ABI,
        functionName: "balanceOf",
        args: address ? [address] : undefined,
      },
      // 8 — Adresse EURC dans Treasury (vérification)
      { ...treasury, functionName: "eurc" },
    ],
    query: {
      enabled: !!address,
      refetchInterval: 30_000,
    },
  });

  const gldBalance    = data?.[0]?.result as bigint | undefined;
  const gldSupply     = data?.[1]?.result as bigint | undefined;
  const usdcBalance   = data?.[2]?.result as bigint | undefined;
  const usdcTotal     = data?.[3]?.result as bigint | undefined;

  // ── getPrice() V3 : (uint256, uint8) — PAS (uint256, bool) ────────────────
  const priceData = data?.[4]?.result as [bigint, number] | undefined;
  const price     = priceData?.[0];
  // source: 0=médiane CL+TL, 1=Chainlink, 2=Tellor, 3=fallback
  const priceSource = priceData?.[1] ?? 3;
  const isOracle    = priceSource <= 2; // true si oracle actif (pas fallback)

  const reserveStatus = data?.[5]?.result as readonly [
    bigint, bigint, bigint, bigint, bigint, boolean, boolean, bigint, bigint
  ] | undefined;
  const lingotOrAddr = data?.[6]?.result as string | undefined;
  const eurcBalance  = data?.[7]?.result as bigint | undefined;

  const isV2Mode = lingotOrAddr !== undefined &&
                   lingotOrAddr !== "0x0000000000000000000000000000000000000000";

  const priceSourceLabel = (() => {
    switch (priceSource) {
      case 0: return "Chainlink + Tellor";
      case 1: return "Chainlink";
      case 2: return "Tellor";
      default: return "Fallback";
    }
  })();

  return {
    raw: { gldBalance, gldSupply, usdcBalance, usdcTotal, price, eurcBalance },

    formatted: {
      gldBalance:  gldBalance  !== undefined ? formatUnits(gldBalance, 3)  : "—",
      gldSupply:   gldSupply   !== undefined ? formatUnits(gldSupply, 3)   : "—",
      usdcBalance: usdcBalance !== undefined ? formatUnits(usdcBalance, 6) : "—",
      eurcBalance: eurcBalance !== undefined ? formatUnits(eurcBalance, 6) : "—",
      usdcTotal:   usdcTotal   !== undefined ? formatUnits(usdcTotal, 6)   : "—",
      pricePerGram: price !== undefined
        ? `$${(Number(price) / 1e8).toFixed(2)}`
        : "—",
      pricePerOz: price !== undefined
        ? `$${(Number(price) / 1e8 * 31.1035).toFixed(2)}`
        : "—",
      marketCapUsdc: (gldSupply !== undefined && price !== undefined)
        ? (gldSupply * price) / 100000n
        : undefined,
    },

    reserve: {
      usdcReserve:    reserveStatus?.[0],
      gldSupply:      reserveStatus?.[1],
      goldValueUsdc:  reserveStatus?.[2],
      ratioBps:       reserveStatus?.[3],
      minRatioBps:    reserveStatus?.[4],
      healthy:        reserveStatus?.[5] ?? true,
      exchangePaused: reserveStatus?.[6] ?? false,
      price:          reserveStatus?.[7],
      deficitUsdc:    reserveStatus?.[8],
      isV2Mode,
      usdcReserveFormatted: (() => {
        const v = reserveStatus?.[0];
        if (v === undefined) return "—";
        if (isV2Mode) return `${(Number(v) / 1000).toFixed(3)} g`;
        return `${parseFloat(formatUnits(v, 6)).toFixed(2)} USDC`;
      })(),
      goldValueFormatted: (() => {
        const v = reserveStatus?.[2];
        if (v === undefined) return "—";
        if (isV2Mode) return `${(Number(v) / 1000).toFixed(3)} g`;
        return `${parseFloat(formatUnits(v, 6)).toFixed(2)} USDC`;
      })(),
      ratioPercent: (() => {
        const r = reserveStatus?.[3];
        if (r === undefined) return "—";
        if (r > 100_000n) return "∞";
        return (Number(r) / 100).toFixed(1) + "%";
      })(),
    },

    // Source du prix pour affichage
    priceSource: priceSourceLabel,
    isOracle,
    isLoading,
    isError,
    refetch,
  };
}

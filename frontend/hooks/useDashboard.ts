import { useReadContracts } from "wagmi";
import { useAccount } from "wagmi";
import { useContracts } from "./useContracts";
import { formatUnits } from "viem";

/**
 * Agrège toutes les données du Dashboard en un seul appel multicall.
 * Retourne les données formatées et prêtes à l'affichage.
 */
export function useDashboard() {
  const { address } = useAccount();
  const { gld, treasury, exchange, reserve } = useContracts();

  const { data, isLoading, isError, refetch } = useReadContracts({
    contracts: [
      // 0 — Balance GLD de l'utilisateur
      {
        ...gld,
        functionName: "balanceOf",
        args: address ? [address] : undefined,
      },
      // 1 — Total supply GLD
      {
        ...gld,
        functionName: "totalSupply",
      },
      // 2 — Balance USDC déposée par l'utilisateur dans Treasury
      {
        ...treasury,
        functionName: "balanceOf",
        args: address ? [address] : undefined,
      },
      // 3 — Total USDC dans Treasury
      {
        ...treasury,
        functionName: "totalDeposited",
      },
      // 4 — Prix or actuel (oracle ou fallback)
      {
        ...exchange,
        functionName: "getPrice",
      },
      // 5 — État complet de la réserve
      {
        ...reserve,
        functionName: "getReserveStatus",
      },
    ],
    query: {
      enabled: !!address,
      refetchInterval: 30_000, // Rafraîchir toutes les 30s
    },
  });

  // Formatage des résultats
  const gldBalance    = data?.[0]?.result as bigint | undefined;
  const gldSupply     = data?.[1]?.result as bigint | undefined;
  const usdcBalance   = data?.[2]?.result as bigint | undefined;
  const usdcTotal     = data?.[3]?.result as bigint | undefined;
  const priceData     = data?.[4]?.result as [bigint, boolean] | undefined;
  const reserveStatus = data?.[5]?.result as readonly [
    bigint, bigint, bigint, bigint, bigint, boolean, boolean, bigint, bigint
  ] | undefined;

  const price    = priceData?.[0];
  const isOracle = priceData?.[1] ?? false;

  return {
    // Valeurs brutes (bigint)
    raw: { gldBalance, gldSupply, usdcBalance, usdcTotal, price },

    // Valeurs formatées pour l'affichage
    formatted: {
      // GLD : decimals = 3
      gldBalance:  gldBalance  !== undefined ? formatUnits(gldBalance, 3)  : "—",
      gldSupply:   gldSupply   !== undefined ? formatUnits(gldSupply, 3)   : "—",
      // USDC : decimals = 6
      usdcBalance: usdcBalance !== undefined ? formatUnits(usdcBalance, 6) : "—",
      usdcTotal:   usdcTotal   !== undefined ? formatUnits(usdcTotal, 6)   : "—",
      // Prix Chainlink XAU/USD : 8 décimales, valeur par ONCE troy
      // Prix en $/gramme directement (8 décimales)
      pricePerGram: price !== undefined
        ? `$${(Number(price) / 1e8).toFixed(2)}`
        : "—",
      pricePerOz: price !== undefined
        ? `$${(Number(price) / 1e8 * 31.1035).toFixed(2)}`
        : "—",
    },

    // Réserve
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
      // Ratio formaté : 10000 bps = 100%
      // MaxUint256 = supply GLD = 0 → afficher "∞" (sur-collatéralisé)
      ratioPercent: (() => {
        const r = reserveStatus?.[3];
        if (r === undefined) return "—";
        // MaxUint256 ou valeur astronomique → supply = 0, ratio infini
        if (r > 100_000n) return "∞";
        return (Number(r) / 100).toFixed(1) + "%";
      })(),
    },

    isOracle,
    isLoading,
    isError,
    refetch,
  };
}

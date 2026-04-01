import { useChainId } from "wagmi";
import { getAddresses } from "@/lib/addresses";
import { GLDABI, TreasuryABI, ExchangeABI, ReserveABI, EventLoggerABI } from "@/lib/abis";

/**
 * Retourne les configs de contrats (address + abi) pour le réseau actif.
 * À utiliser dans useReadContract, useWriteContract, etc.
 */
export function useContracts() {
  const chainId = useChainId();
  const addresses = getAddresses(chainId);

  return {
    gld: {
      address: addresses.GLD,
      abi: GLDABI,
    },
    treasury: {
      address: addresses.Treasury,
      abi: TreasuryABI,
    },
    exchange: {
      address: addresses.Exchange,
      abi: ExchangeABI,
    },
    reserve: {
      address: addresses.Reserve,
      abi: ReserveABI,
    },
    eventLogger: {
      address: addresses.EventLogger,
      abi: EventLoggerABI,
    },
  };
}

import { hardhat, sepolia } from "wagmi/chains";

export type ContractAddresses = {
  GLD: `0x${string}`;
  Treasury: `0x${string}`;
  Exchange: `0x${string}`;
  Reserve: `0x${string}`;
  EventLogger: `0x${string}`;
  SerialNumber: `0x${string}`;
};

// ── Adresses Sepolia (à remplir après déploiement) ─────────────────────────
const SEPOLIA_ADDRESSES: ContractAddresses = {
  GLD:          "0x0000000000000000000000000000000000000000",
  Treasury:     "0x0000000000000000000000000000000000000000",
  Exchange:     "0x0000000000000000000000000000000000000000",
  Reserve:      "0x0000000000000000000000000000000000000000",
  EventLogger:  "0x0000000000000000000000000000000000000000",
  SerialNumber: "0x0000000000000000000000000000000000000000",
};

// ── Adresses Hardhat local (à remplir après npx hardhat node) ──────────────
const HARDHAT_ADDRESSES: ContractAddresses = {
  GLD:          "0x0000000000000000000000000000000000000000",
  Treasury:     "0x0000000000000000000000000000000000000000",
  Exchange:     "0x0000000000000000000000000000000000000000",
  Reserve:      "0x0000000000000000000000000000000000000000",
  EventLogger:  "0x0000000000000000000000000000000000000000",
  SerialNumber: "0x0000000000000000000000000000000000000000",
};

const ADDRESSES: Record<number, ContractAddresses> = {
  [sepolia.id]: SEPOLIA_ADDRESSES,
  [hardhat.id]: HARDHAT_ADDRESSES,
};

export function getAddresses(chainId: number): ContractAddresses {
  return ADDRESSES[chainId] ?? SEPOLIA_ADDRESSES;
}

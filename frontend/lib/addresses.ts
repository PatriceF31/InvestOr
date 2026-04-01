import { hardhat, sepolia } from "wagmi/chains";

export type ContractAddresses = {
  GLD: `0x${string}`;
  Treasury: `0x${string}`;
  Exchange: `0x${string}`;
  Reserve: `0x${string}`;
  EventLogger: `0x${string}`;
  SerialNumber: `0x${string}`;
};

// ── Adresses Sepolia ───────────────────────────────────────────────────────
const SEPOLIA_ADDRESSES: ContractAddresses = {
  GLD:          "0xA4ddCDf84F0C0acC8cA22E77f501d308C4E87dD4",
  Treasury:     "0x8483E1226788B860068c9e9812191b57aCa48af9",
  Exchange:     "0xdd18eF05AEafbe9F903577eC936a92CF2E236fA9",
  Reserve:      "0x2BccE567A57F6c8A4736bB99eBb7bB0535334e8C",
  EventLogger:  "0x70eFf6af5aCE213cEe7a3AFC4587db478c4F4b5a",
  SerialNumber: "0x24622EfA10CfBA2B6F0e2845a89B09711293867d",
};

// ── Adresses Hardhat local ─────────────────────────────────────────────────
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

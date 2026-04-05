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
  Treasury:     "0x195Fa6df09e9e69195f1D649E877f8bbBB7cB6b3",
  Exchange:     "0xdd18eF05AEafbe9F903577eC936a92CF2E236fA9",
  Reserve:      "0x14424FC3f813001f040DbC061E95dB4e66A89F5c",
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

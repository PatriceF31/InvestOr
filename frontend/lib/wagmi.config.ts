import { http, createConfig } from "wagmi";
import { hardhat, sepolia } from "wagmi/chains";
import { injected, metaMask, walletConnect } from "wagmi/connectors";

const walletConnectProjectId =
  process.env.NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID ?? "fe53e9659b588d74465b9eed9f8a73f8";

export const wagmiConfig = createConfig({
  chains: [sepolia, hardhat],
  connectors: [
    injected(),
    metaMask(),
    walletConnect({ projectId: walletConnectProjectId }),
  ],
  transports: {
    [sepolia.id]: http(
      process.env.NEXT_PUBLIC_SEPOLIA_RPC_URL ?? "https://rpc.sepolia.org"
    ),
    [hardhat.id]: http("http://127.0.0.1:8545"),
  },
});

export const SUPPORTED_CHAINS = [sepolia, hardhat];

export const DEFAULT_CHAIN =
  process.env.NEXT_PUBLIC_DEFAULT_CHAIN === "hardhat" ? hardhat : sepolia;

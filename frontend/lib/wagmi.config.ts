import { getDefaultConfig } from "@rainbow-me/rainbowkit";
import { hardhat, sepolia } from "wagmi/chains";
import { http } from "wagmi";

const walletConnectProjectId =
  process.env.NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID ?? "fe53e9659b588d74465b9eed9f8a73f8";

export const wagmiConfig = getDefaultConfig({
  appName: "InvestOr",
  projectId: walletConnectProjectId,
  chains: [sepolia, hardhat],
  transports: {
    [sepolia.id]: http(
      process.env.NEXT_PUBLIC_SEPOLIA_RPC_URL ?? "https://rpc.sepolia.org"
    ),
    [hardhat.id]: http("http://127.0.0.1:8545"),
  },
  ssr: false, // Pages Router — pas de SSR
});

export const DEFAULT_CHAIN =
  process.env.NEXT_PUBLIC_DEFAULT_CHAIN === "hardhat" ? hardhat : sepolia;

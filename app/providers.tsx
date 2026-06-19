"use client";

import { DynamicContextProvider } from "@dynamic-labs/sdk-react-core";
import { DynamicWagmiConnector } from "@dynamic-labs/wagmi-connector";
import { EthereumWalletConnectors } from "@dynamic-labs/ethereum";
import { createConfig, WagmiProvider } from "wagmi";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { http } from "viem";
import { base, mainnet, sepolia } from "viem/chains";

// Client-side RPC for wagmi reads + the embedded wallet's co-sign UserOps. The embedded wallet is
// the sudo owner of the user's smart account, so it must be able to sign on the value chain (Base)
// and the identity chain (mainnet). Public nodes by default; override per chain via env. Use a
// getLogs-capable provider (e.g. Alchemy) so funding detection works.
const baseRpc = process.env.NEXT_PUBLIC_BASE_RPC_URL ?? "https://mainnet.base.org";
const mainnetRpc = process.env.NEXT_PUBLIC_MAINNET_RPC_URL ?? "https://ethereum-rpc.publicnode.com";
const sepoliaRpc =
  process.env.NEXT_PUBLIC_SEPOLIA_RPC_URL ?? "https://ethereum-sepolia-rpc.publicnode.com";

const config = createConfig({
  chains: [base, mainnet, sepolia],
  // Dynamic implements multi-injected-provider-discovery itself.
  multiInjectedProviderDiscovery: false,
  transports: {
    [base.id]: http(baseRpc),
    [mainnet.id]: http(mainnetRpc),
    [sepolia.id]: http(sepoliaRpc),
  },
});

// Tell Dynamic about the same chains wagmi uses, so the embedded wallet can sign on them (the SA's
// owner must sign UserOps on Base + mainnet). Without this Dynamic warns + can't switch to them.
const evmNetworks = [
  {
    blockExplorerUrls: ["https://basescan.org"],
    chainId: base.id,
    chainName: "Base",
    iconUrls: ["https://app.dynamic.xyz/assets/networks/base.svg"],
    name: "Base",
    nativeCurrency: { decimals: 18, name: "Ether", symbol: "ETH" },
    networkId: base.id,
    rpcUrls: [baseRpc],
    vanityName: "Base",
  },
  {
    blockExplorerUrls: ["https://etherscan.io"],
    chainId: mainnet.id,
    chainName: "Ethereum",
    iconUrls: ["https://app.dynamic.xyz/assets/networks/eth.svg"],
    name: "Ethereum",
    nativeCurrency: { decimals: 18, name: "Ether", symbol: "ETH" },
    networkId: mainnet.id,
    rpcUrls: [mainnetRpc],
    vanityName: "Ethereum",
  },
  {
    blockExplorerUrls: ["https://sepolia.etherscan.io"],
    chainId: sepolia.id,
    chainName: "Sepolia",
    iconUrls: ["https://app.dynamic.xyz/assets/networks/eth.svg"],
    name: "Sepolia",
    nativeCurrency: { decimals: 18, name: "Sepolia Ether", symbol: "ETH" },
    networkId: sepolia.id,
    rpcUrls: [sepoliaRpc],
    vanityName: "Sepolia",
  },
];

const queryClient = new QueryClient();

export function Providers({ children }: { children: React.ReactNode }) {
  return (
    <DynamicContextProvider
      theme="dark"
      settings={{
        environmentId:
          process.env.NEXT_PUBLIC_DYNAMIC_ENVIRONMENT_ID ??
          "bbd27798-ec7d-4aa5-ba43-694d10a6baf9",
        walletConnectors: [EthereumWalletConnectors],
        // Brand the modal as Ignis; the dark base is the `theme` prop above, and
        // the flame accent + radius come from the .dynamic-shadow-dom rule in globals.css.
        appName: "Ignis",
        overrides: { evmNetworks },
      }}
    >
      <WagmiProvider config={config}>
        <QueryClientProvider client={queryClient}>
          <DynamicWagmiConnector>{children}</DynamicWagmiConnector>
        </QueryClientProvider>
      </WagmiProvider>
    </DynamicContextProvider>
  );
}

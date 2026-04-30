"use client";

import { ConnectionProvider, WalletProvider } from "@solana/wallet-adapter-react";
import { WalletModalProvider } from "@solana/wallet-adapter-react-ui";
import { useMemo } from "react";
import "@solana/wallet-adapter-react-ui/styles.css";

export default function WalletContextProvider({ children }: { children: React.ReactNode }) {
  const endpoint = process.env.NEXT_PUBLIC_HELIUS_RPC_URL 
    ? process.env.NEXT_PUBLIC_HELIUS_RPC_URL 
    : (process.env.NEXT_PUBLIC_HELIUS_API_KEY 
        ? `https://mainnet.helius-rpc.com/?api-key=${process.env.NEXT_PUBLIC_HELIUS_API_KEY}`
        : "https://api.mainnet-beta.solana.com");

  // Wallet adapters can be added here if needed, but modern standard uses the wallet-standard auto-detection mostly
  const wallets = useMemo(() => [], []);

  return (
    <ConnectionProvider endpoint={endpoint}>
      <WalletProvider 
        wallets={wallets} 
        autoConnect={false}
        onError={(error) => {
          // Suppress Next.js red overlay for user rejections
          if (/user rejected|rejected the request/i.test(error.message)) {
            console.warn(error);
          } else {
            console.error(error);
          }
        }}
      >
        <WalletModalProvider>
          {children}
        </WalletModalProvider>
      </WalletProvider>
    </ConnectionProvider>
  );
}

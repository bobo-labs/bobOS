"use client";

import { ConnectionProvider, WalletProvider } from "@solana/wallet-adapter-react";
import { WalletModalProvider } from "@solana/wallet-adapter-react-ui";
import { useMemo } from "react";
import { PhantomWalletAdapter } from "@solana/wallet-adapter-phantom";
import { SolflareWalletAdapter } from "@solana/wallet-adapter-solflare";
import "@solana/wallet-adapter-react-ui/styles.css";

export default function WalletContextProvider({ children }: { children: React.ReactNode }) {
  const endpoint = process.env.NEXT_PUBLIC_HELIUS_RPC_URL 
    ? process.env.NEXT_PUBLIC_HELIUS_RPC_URL 
    : (process.env.NEXT_PUBLIC_HELIUS_API_KEY 
        ? `https://mainnet.helius-rpc.com/?api-key=${process.env.NEXT_PUBLIC_HELIUS_API_KEY}`
        : "https://api.mainnet-beta.solana.com");

  // Explicitly list adapters to support legacy injected wallet providers inside mobile webviews (like pump.fun app)
  const wallets = useMemo(() => [
    new PhantomWalletAdapter(),
    new SolflareWalletAdapter(),
  ], []);

  return (
    <ConnectionProvider endpoint={endpoint}>
      <WalletProvider 
        wallets={wallets} 
        autoConnect={true}
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

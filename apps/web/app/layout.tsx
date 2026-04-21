import "./globals.css";
import WalletContextProvider from "../components/WalletContextProvider";

export const metadata = {
  title: "Bobo the Bear | Web3 Roast",
  description: "Your portfolio is going to zero.",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <body className="antialiased min-h-screen bg-stark-white text-pitch-black font-mono">
        <WalletContextProvider>
          {children}
        </WalletContextProvider>
      </body>
    </html>
  );
}

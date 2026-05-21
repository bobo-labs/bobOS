import "./globals.css";
import { Oswald, Bangers } from "next/font/google";
import WalletContextProvider from "../components/WalletContextProvider";

const oswald = Oswald({
  subsets: ["latin"],
  variable: "--font-oswald",
});

const bangers = Bangers({
  weight: "400",
  subsets: ["latin"],
  variable: "--font-bangers",
});

export const metadata = {
  metadataBase: new URL("https://ai.bobolabs.xyz"),
  title: "bobo_OS",
  description: "Your portfolio is going to zero.",
  openGraph: {
    title: "bobo_OS",
    description: "Your portfolio is going to zero. Connect your wallet and face judgment.",
    siteName: "bobo_OS",
    images: [
      {
        url: "https://ai.bobolabs.xyz/images/dev-card.webp",
        width: 1200,
        height: 630,
        alt: "bobo_OS — Your portfolio is going to zero.",
      },
    ],
  },
  twitter: {
    card: "summary_large_image",
    title: "bobo_OS",
    description: "Your portfolio is going to zero.",
    images: ["https://ai.bobolabs.xyz/images/dev-card.webp"],
  },
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <body className={`antialiased min-h-screen bg-stark-white text-pitch-black font-mono ${oswald.variable} ${bangers.variable}`}>
        <WalletContextProvider>
          {children}
        </WalletContextProvider>
      </body>
    </html>
  );
}


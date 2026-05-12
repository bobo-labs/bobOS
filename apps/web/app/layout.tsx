import "./globals.css";
import WalletContextProvider from "../components/WalletContextProvider";

export const metadata = {
  title: "bobo_OS",
  description: "Your portfolio is going to zero.",
  openGraph: {
    title: "bobo_OS",
    description: "Your portfolio is going to zero. Connect your wallet and face judgment.",
    siteName: "bobo_OS",
    images: [
      {
        url: "/images/bobo-ascii.png",
        width: 800,
        height: 800,
        alt: "Bobo the Bear",
      },
    ],
  },
  twitter: {
    card: "summary_large_image",
    title: "bobo_OS",
    description: "Your portfolio is going to zero.",
    images: ["/images/bobo-ascii.png"],
  },
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

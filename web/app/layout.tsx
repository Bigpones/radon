import type { Metadata, Viewport } from "next";
import { IBM_Plex_Sans, IBM_Plex_Mono } from "next/font/google";
import Providers from "@/components/Providers";
import PwaRegister from "@/components/PwaRegister";
import ThemeBootstrap from "@/components/ThemeBootstrap";
import "./globals.css";

// Self-hosted via next/font/google — replaces the render-blocking
// `@import url("https://fonts.googleapis.com/...")` line that previously
// fronted globals.css. Plex Sans + Plex Mono together create the
// IBM-workstation-circa-1985 identity called out in the audit (MOVE 6).
// `variable` exposes the family as a CSS custom property so existing
// `var(--font-sans)` / `var(--font-mono)` references continue to work.
const plexSans = IBM_Plex_Sans({
  subsets: ["latin"],
  weight: ["400", "500", "600", "700"],
  variable: "--font-sans",
  display: "swap",
});

const plexMono = IBM_Plex_Mono({
  subsets: ["latin"],
  weight: ["400", "500", "600", "700"],
  variable: "--font-mono",
  display: "swap",
});

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  maximumScale: 5,
  viewportFit: "cover",
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#ffffff" },
    { media: "(prefers-color-scheme: dark)", color: "#0a0f14" },
  ],
};

export const metadata: Metadata = {
  title: "Radon Terminal",
  description: "Market structure reconstruction instrument. Surfaces convex opportunities from institutional flow, volatility surfaces, and cross-asset positioning.",
  manifest: "/manifest.webmanifest",
  appleWebApp: {
    capable: true,
    statusBarStyle: "black-translucent",
    title: "Radon",
  },
  icons: {
    icon: [
      { url: "/icons/favicon-16x16.png", sizes: "16x16", type: "image/png" },
      { url: "/icons/favicon-32x32.png", sizes: "32x32", type: "image/png" },
      { url: "/icons/favicon-64x64.png", sizes: "64x64", type: "image/png" },
    ],
    apple: "/icons/apple-touch-icon.png",
  },
  openGraph: {
    title: "Radon Terminal",
    description: "Reconstructing market structure from noisy signals.",
    images: [
      {
        url: "/images/hero-og.png",
        width: 1200,
        height: 630,
        alt: "Radon Terminal - Market Structure Reconstruction",
      },
      {
        url: "/images/markov-og.png",
        width: 1200,
        height: 630,
        alt: "Radon Terminal - Markov State Reconstruction",
      },
    ],
  },
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html
      lang="en"
      suppressHydrationWarning
      className={`${plexSans.variable} ${plexMono.variable}`}
    >
      <head>
        <ThemeBootstrap />
      </head>
      <body className="app-root">
        <Providers>{children}</Providers>
        <PwaRegister />
      </body>
    </html>
  );
}

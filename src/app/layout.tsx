import type { Metadata } from "next";
import { Geist, Geist_Mono, Fraunces } from "next/font/google";
import { Toaster } from "@/components/ui/sonner";
import { ChatWidget } from "@/components/chat-widget";
import { AnalyticsTracker } from "@/components/analytics-tracker";
import { SiteFooter } from "@/components/site-footer";
import "./globals.css";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

// Editorial display serif for the exhibitor portal (maps to Tailwind font-serif).
const fraunces = Fraunces({
  variable: "--font-fraunces",
  subsets: ["latin"],
  weight: ["400", "500", "600", "700"],
  style: ["normal", "italic"],
});

const SITE_URL = process.env.NEXT_PUBLIC_SITE_URL || "https://cthalaal.co.za";

export const metadata: Metadata = {
  metadataBase: new URL(SITE_URL),
  title: {
    default: "Young at Heart Festival 2026 | Cape Town Halaal Lifestyle Expo",
    template: "%s | Young at Heart 2026",
  },
  description: "Cape Town's premier halal lifestyle exhibition. 11 to 13 December 2026 at Youngsfield Military Base. Food, fashion, beauty, travel and more.",
  keywords: ["young at heart festival", "cape town halaal", "halal festival", "cape town festival", "lifestyle exhibition", "youngsfield military base", "south africa", "december 2026"],
  authors: [{ name: "Young at Heart Festival Support" }],
  alternates: {
    canonical: "/",
  },
  icons: {
    icon: [
      { url: "/icon.svg?v=2", type: "image/svg+xml" },
      { url: "/favicon.ico?v=2", sizes: "any" },
      { url: "/icon-192.png?v=2", sizes: "192x192", type: "image/png" },
      { url: "/icon-512.png?v=2", sizes: "512x512", type: "image/png" },
    ],
    apple: "/apple-touch-icon.png?v=2",
  },
  openGraph: {
    title: "Young at Heart Festival 2026 | Cape Town Halaal Lifestyle Expo",
    description: "Cape Town's premier halal lifestyle exhibition. 11 to 13 December 2026 at Youngsfield Military Base.",
    url: "/",
    siteName: "Young at Heart Festival",
    type: "website",
    locale: "en_ZA",
  },
  twitter: {
    card: "summary_large_image",
    title: "Young at Heart Festival 2026 | Cape Town",
    description: "Cape Town's premier halal lifestyle exhibition. 11 to 13 December 2026.",
  },
  robots: {
    index: true,
    follow: true,
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body
        className={`${geistSans.variable} ${geistMono.variable} ${fraunces.variable} antialiased bg-white text-neutral-900`}
      >
        {children}
        <SiteFooter />
        <Toaster />
        <ChatWidget />
        <AnalyticsTracker />
      </body>
    </html>
  );
}

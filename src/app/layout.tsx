import { GeistMono } from "geist/font/mono";
import { GeistSans } from "geist/font/sans";
import type { Metadata, Viewport } from "next";
import type { ReactNode } from "react";

import { cn } from "@/lib/utils";

import "./globals.css";

export const metadata: Metadata = {
  title: {
    default: "Agent Studio",
    template: "%s · Agent Studio",
  },
  description: "Streaming agent chat alongside a live, interactive artifact canvas.",
  applicationName: "Agent Studio",
};

export const viewport: Viewport = {
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#fcfcfc" },
    { media: "(prefers-color-scheme: dark)", color: "#09090b" },
  ],
};

export default function RootLayout({ children }: Readonly<{ children: ReactNode }>) {
  // Geist is bundled locally (no build-time font download), keeping builds hermetic.
  return (
    <html lang="en" className={cn(GeistSans.variable, GeistMono.variable)}>
      <body className="min-h-dvh">{children}</body>
    </html>
  );
}

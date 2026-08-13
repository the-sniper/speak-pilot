import type { Metadata } from "next";
import { Plus_Jakarta_Sans, IBM_Plex_Mono } from "next/font/google";
import "./globals.css";
import AppShell from "@/components/AppShell";
import DemoBanner from "@/components/DemoBanner";
import MockModeBanner from "@/components/MockModeBanner";
import { isMockProviderActive } from "@/lib/llm/adapter";

// Plus Jakarta Sans stands in for Speak's Axiforma (Typekit) — geometric,
// bold marketing grotesk. One family for display + body keeps the UI calm.
// IBM Plex Mono marks data (band codes, learner ids).
const jakarta = Plus_Jakarta_Sans({
  variable: "--font-display",
  subsets: ["latin"],
  weight: ["400", "500", "600", "700", "800"],
});

const jakartaBody = Plus_Jakarta_Sans({
  variable: "--font-body",
  subsets: ["latin"],
  weight: ["400", "500", "600", "700"],
});

const plexMono = IBM_Plex_Mono({
  variable: "--font-data",
  subsets: ["latin"],
  weight: ["400", "500"],
});

export const metadata: Metadata = {
  title: "Speak Pilot",
  description: "Grounded English training programs, generated from one line.",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  const mock = isMockProviderActive();
  return (
    <html
      lang="en"
      className={`${jakarta.variable} ${jakartaBody.variable} ${plexMono.variable} h-full antialiased`}
    >
      <body className={`min-h-full flex flex-col${mock ? " pb-12" : ""}`}>
        <DemoBanner />
        <AppShell />
        {children}
        <MockModeBanner />
      </body>
    </html>
  );
}

import type { Metadata } from "next";
import { Fraunces, Public_Sans, IBM_Plex_Mono } from "next/font/google";
import "./globals.css";
import HonestyBanner from "@/components/HonestyBanner";
import MockModeBanner from "@/components/MockModeBanner";
import { isMockProviderActive } from "@/lib/llm/adapter";

// Fraunces: the display voice for section eyebrows and the kickoff card —
// a wide-optical-size serif with real character, not another Inter/Roboto
// default. Public Sans carries body copy and UI chrome. IBM Plex Mono marks
// anything that is data (band codes, learner ids, session counts) so the
// eye can tell "the model's prose" from "a grounded fact" at a glance.
const fraunces = Fraunces({
  variable: "--font-display",
  subsets: ["latin"],
  style: ["normal", "italic"],
  axes: ["opsz", "SOFT"],
});

const publicSans = Public_Sans({
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
  // Read once per render, server-side only — see MockModeBanner's doc
  // comment for why this can't be a client-side env-var read. Also drives
  // the bottom padding so the fixed banner never overlaps the last thing on
  // a page (e.g. the QBR's print button, the program page's advance button).
  const mock = isMockProviderActive();
  return (
    <html
      lang="en"
      className={`${fraunces.variable} ${publicSans.variable} ${plexMono.variable} h-full antialiased`}
    >
      <body className={`min-h-full flex flex-col${mock ? " pb-12" : ""}`}>
        <HonestyBanner />
        {children}
        <MockModeBanner />
      </body>
    </html>
  );
}

import type { Metadata } from "next";
import { DM_Serif_Display, Inter } from "next/font/google";
import type { ReactNode } from "react";
import "./globals.css";
import "./style.css";

const inter = Inter({
  weight: ["400", "500", "600", "700"],
  subsets: ["latin", "latin-ext"],
  variable: "--font-ss-sans",
});

const dmSerif = DM_Serif_Display({
  weight: "400",
  subsets: ["latin"],
  variable: "--font-ss-display",
});

export const metadata: Metadata = {
  title: "Sub Scribe — YouTube Subtitle Language Practice",
  description:
    "Learn any language by typing or speaking along with YouTube subtitles. Paste a video link, pick a caption track, and practice in real-time. Free, no signup.",
  keywords: [
    "youtube language learning",
    "subtitle typing practice",
    "youtube captions study",
    "language learning with youtube",
    "subtitle dictation",
    "youtube speech practice",
    "learn language free",
    "caption typing trainer",
    "youtube subtitle practice",
    "language listening practice",
  ],
  alternates: {
    canonical: "/",
  },
  openGraph: {
    title: "Sub Scribe — YouTube Subtitle Language Practice",
    description:
      "Learn any language by typing or speaking along with YouTube subtitles. Free, no signup.",
    url: "/",
  },
  twitter: {
    title: "Sub Scribe — YouTube Subtitle Language Practice",
    description:
      "Learn any language by typing or speaking along with YouTube subtitles. Free, no signup.",
  },
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body className={`${inter.variable} ${dmSerif.variable}`}>{children}</body>
    </html>
  );
}

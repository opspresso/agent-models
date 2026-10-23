import "@mantine/core/styles.layer.css";
import "./globals.css";
import { ColorSchemeScript, mantineHtmlProps } from "@mantine/core";
import { Figtree, JetBrains_Mono } from "next/font/google";
import { Providers } from "./providers.tsx";
import { locale } from "./locale.ts";
const sans = Figtree({ subsets: ["latin"], variable: "--font-sans", display: "swap" });
const mono = JetBrains_Mono({ subsets: ["latin"], variable: "--font-mono", display: "swap" });
export const metadata = { title: { default: "Agent Models", template: "%s · Agent Models" }, description: "Central model management, routing and usage for the Agent platform", icons: { icon: "/favicon.ico" } };
export default async function RootLayout({ children }: { children: React.ReactNode }) {
  const language = await locale();
  return <html lang={language} className={`${sans.variable} ${mono.variable}`} {...mantineHtmlProps}><head><ColorSchemeScript defaultColorScheme="auto" /></head><body><Providers locale={language}>{children}</Providers></body></html>;
}

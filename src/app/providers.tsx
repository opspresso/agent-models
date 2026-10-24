"use client";
import { createContext, useContext, useCallback, type ReactNode } from "react";
import { MantineProvider } from "@mantine/core";
import { theme, consoleCssVariables } from "./theme.ts";
import { en, ko, type Locale, type MessageKey } from "./messages.ts";
const LocaleContext = createContext<Locale>("en");
export function Providers({ locale, children }: { locale: Locale; children: ReactNode }) {
  return <MantineProvider theme={theme} cssVariablesResolver={consoleCssVariables} defaultColorScheme="auto"><LocaleContext.Provider value={locale}>{children}</LocaleContext.Provider></MantineProvider>;
}
export function useLocale() { return useContext(LocaleContext); }
export function useT() { const locale = useLocale(); return useCallback((key: MessageKey): string => (locale === "ko" ? ko : en)[key], [locale]); }

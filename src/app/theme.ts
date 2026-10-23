"use client";

import { createTheme, darken, luminance, type CSSVariablesResolver, type MantineColorsTuple } from "@mantine/core";

/** Shared blue palette follows both public/brands icon sets. */
const brand: MantineColorsTuple = [
  "#eff6ff",
  "#dbeafe",
  "#bfdbfe",
  "#93c5fd",
  "#60a5fa",
  "#3b82f6",
  "#2563eb",
  "#1d4ed8",
  "#1e40af",
  "#1e3a8a",
];

export const theme = createTheme({
  primaryColor: "brand",
  primaryShade: { light: 7, dark: 7 },
  autoContrast: true,
  // Switch between black and white at their equal-contrast luminance.
  luminanceThreshold: 0.179,
  colors: {
    brand,
    gray: [
      "#f6f7f9",
      "#f0f2f5",
      "#e7eaf0",
      "#dce0e7",
      "#bfc6d1",
      "#99a2b1",
      "#687486",
      "#465366",
      "#303d50",
      "#202b3b",
    ],
    dark: [
      "#eef0f4",
      "#d4d9e2",
      "#aab2c0",
      "#535c6d",
      "#363c48",
      "#2d323d",
      "#252932",
      "#1c1f26",
      "#14161b",
      "#101217",
    ],
  },
  fontFamily:
    'var(--font-sans), ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif',
  fontFamilyMonospace:
    'var(--font-mono), ui-monospace, SFMono-Regular, "SF Mono", Menlo, Monaco, Consolas, "Liberation Mono", monospace',
  radius: { md: "8px", lg: "12px", xl: "16px" },
  defaultRadius: "md",
  focusRing: "auto",
  headings: {
    fontFamily:
      'var(--font-sans), ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif',
    fontWeight: "600",
  },
  components: {
    Button: { defaultProps: { size: "sm" } },
    ActionIcon: { defaultProps: { variant: "subtle", color: "gray", size: "lg" } },
    Card: { defaultProps: { withBorder: true, radius: "lg", padding: "lg" } },
    Paper: { defaultProps: { radius: "lg" } },
    Badge: { defaultProps: { variant: "light", color: "gray", radius: "sm" }, styles: { root: { textTransform: "none", letterSpacing: "normal" } } },
    Alert: { defaultProps: { variant: "light", radius: "md" }, styles: { message: { fontSize: "var(--mantine-font-size-sm)" } } },
    TextInput: { defaultProps: { size: "sm" } },
    Textarea: { defaultProps: { size: "sm" } },
    NumberInput: { defaultProps: { size: "sm" } },
    PasswordInput: { defaultProps: { size: "sm" } },
    Select: { defaultProps: { size: "sm" } },
    MultiSelect: { defaultProps: { size: "sm" } },
    TagsInput: { defaultProps: { size: "sm" } },
    Autocomplete: { defaultProps: { size: "sm" } },
    Checkbox: { defaultProps: { size: "sm" } },
    Switch: { defaultProps: { size: "sm" } },
    Modal: { defaultProps: { radius: "lg", centered: false }, styles: {
      title: { fontWeight: 600, fontSize: "var(--mantine-font-size-lg)" },
      header: { borderBottom: "1px solid var(--console-border)" },
      body: { paddingTop: "var(--mantine-spacing-md)" },
    } },
    Tooltip: { defaultProps: { withArrow: true, fz: "xs" } },
  },
});

/** Light controls use palette shades 1/2 for rest/hover; named text must remain readable on both. */
export const consoleCssVariables: CSSVariablesResolver = (theme) => {
  const light: Record<string, string> = {};
  for (const [name, palette] of Object.entries(theme.colors)) {
    if (!Array.isArray(palette)) continue;
    const backgrounds = [luminance(palette[1]), luminance(palette[2])];
    let ink = palette[9];
    for (let step = 0; step <= 20; step++) {
      ink = darken(palette[9], step / 20);
      const foreground = luminance(ink);
      if (backgrounds.every(background => (Math.max(background, foreground) + 0.05) / (Math.min(background, foreground) + 0.05) >= 4.5)) break;
    }
    light[`--mantine-color-${name}-light-color`] = ink;
    light[`--mantine-color-${name}-text`] = ink;
    light[`--mantine-color-${name}-outline`] = ink;
  }
  return { variables: {}, light, dark: {} };
};

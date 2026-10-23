import { cookies, headers } from "next/headers";
import type { Locale } from "./messages.ts";
export async function locale(): Promise<Locale> {
  const stored = (await cookies()).get("agent-models-locale")?.value;
  if (stored === "en" || stored === "ko") return stored;
  const ranked = ((await headers()).get("accept-language") ?? "").split(",").map(value => {
    const [tag, quality] = value.trim().split(";q="); return { language: tag?.split("-")[0], quality: quality === undefined ? 1 : Number(quality) };
  }).filter(value => value.quality > 0).sort((left, right) => right.quality - left.quality);
  return ranked.find(value => value.language === "en" || value.language === "ko")?.language as Locale | undefined ?? "en";
}

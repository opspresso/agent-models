import type { Observation } from "../../domain/router/transport.ts";
import type { ModelType, Operation, ProviderKind, UsageAmounts } from "../../domain/router/types.ts";
import { createJsonMetadata, type Metadata } from "./json-metadata.ts";

export function createUsageObserver(operation: Operation, kind: ProviderKind, type: ModelType, sse: boolean) {
  const snapshot = new Map<string, number>();
  let complete = false;
  let errorCode: string | null = null;
  let invalid = false;
  let googleFinished = false;
  let json = sse ? undefined : createJsonMetadata();
  let linePrefix = "";
  let lineKind: "prefix" | "data" | "ignored" = "prefix";
  let leadingSpace = false;
  let eventStarted = false;
  let marker = "";
  let done = false;
  const decoder = new TextDecoder("utf-8", { fatal: true });
  function observe(value: Metadata, entireResponse = false) {
    if (!value.valid) { invalid = true; return; }
    for (const [path, number] of value.numbers) snapshot.set(path.replace(/^(?:response|message)\.usage\./, "usage."), number);
    if (type === "image") {
      const images = value.arrays.get("data") ?? value.arrays.get("choices.0.message.images");
      if (images !== undefined) snapshot.set("images", images);
      const deltaImages = value.arrays.get("choices.0.delta.images");
      if (deltaImages !== undefined) snapshot.set("images", (snapshot.get("images") ?? 0) + deltaImages);
    }
    for (const prefix of ["promptTokensDetails", "candidatesTokensDetails"] as const) {
      let imageTokens: number | undefined;
      for (let index = 0; index < 16; index++) {
        if (value.strings.get(`usageMetadata.${prefix}.${index}.modality`) === "IMAGE") imageTokens = value.numbers.get(`usageMetadata.${prefix}.${index}.tokenCount`);
      }
      if (imageTokens !== undefined) snapshot.set(prefix === "promptTokensDetails" ? "google.image_input_tokens" : "google.image_output_tokens", imageTokens);
    }
    const event = value.strings.get("type");
    if (value.hasError || event === "error" || event === "response.failed" || value.strings.get("response.status") === "failed" || value.strings.get("status") === "failed") errorCode = "provider_error";
    if ((operation === "generateContent" || operation === "streamGenerateContent") && value.strings.has("candidates.0.finishReason")) googleFinished = true;
    if (entireResponse || ["response.completed", "response.incomplete", "response.failed", "message_stop"].includes(event ?? "")) complete = true;
  }
  async function data(fragment: string) {
    eventStarted = true;
    if (leadingSpace && fragment) { if (fragment.startsWith(" ")) fragment = fragment.slice(1); leadingSpace = false; }
    if (!json && !done) {
      const needed = 6 - marker.length;
      marker += fragment.slice(0, needed);
      fragment = fragment.slice(needed);
      if (marker.length < 6) return;
      if (marker === "[DONE]") done = true;
      else { json = createJsonMetadata(); await json.write(marker); }
    }
    if (done) { if (fragment.trim()) invalid = true; }
    else if (json) await json.write(fragment);
  }
  async function line(fragment: string, ended: boolean) {
    if (lineKind === "prefix") {
      while (fragment && lineKind === "prefix") {
        linePrefix += fragment[0]; fragment = fragment.slice(1);
        if (linePrefix === "data:") { lineKind = "data"; leadingSpace = true; }
        else if (!"data:".startsWith(linePrefix)) lineKind = "ignored";
      }
    }
    if (lineKind === "data") await data(fragment);
    if (ended) {
      if (!linePrefix && lineKind === "prefix") {
        if (eventStarted) {
          if (done) complete = true;
          else {
            if (!json) { json = createJsonMetadata(); await json.write(marker); }
            observe(await json.end());
          }
        }
        json = undefined; marker = ""; done = false; eventStarted = false;
      } else if (lineKind === "data") await data("\n");
      linePrefix = ""; lineKind = "prefix";
    }
  }
  let pendingCr = false;
  async function text(value: string) {
    if (!sse) { await json!.write(value); return; }
    if (complete) return;
    if (pendingCr) { if (value.startsWith("\n")) value = value.slice(1); pendingCr = false; }
    let offset = 0;
    for (let index = 0; index < value.length; index++) {
      if (value[index] !== "\r" && value[index] !== "\n") continue;
      await line(value.slice(offset, index), true);
      if (complete) return;
      if (value[index] === "\r") {
        if (value[index + 1] === "\n") index++;
        else if (index + 1 === value.length) pendingCr = true;
      }
      offset = index + 1;
    }
    if (offset < value.length) await line(value.slice(offset), false);
  }
  return {
    async write(bytes: Uint8Array) {
      try { await text(decoder.decode(bytes, { stream: true })); }
      catch { invalid = true; json?.cancel(); }
    },
    async end() {
      try {
        await text(decoder.decode());
        if (!sse) observe(await json!.end(), true);
        else if (eventStarted) { json?.cancel(); invalid = true; }
        else if (operation === "streamGenerateContent" && googleFinished) complete = true;
      } catch { invalid = true; json?.cancel(); }
    },
    cancel() { json?.cancel(); },
    result(): Observation {
      const number = (...paths: string[]) => paths.map(path => snapshot.get(path)).find(value => value !== undefined && Number.isFinite(value) && value >= 0);
      const counter = (...paths: string[]) => { const value = number(...paths); return value !== undefined && Number.isSafeInteger(value) ? value : undefined; };
      const amounts: UsageAmounts = {};
      let invalidAmounts = [...snapshot.entries()].some(([path, value]) => !Number.isFinite(value) || value < 0 ||
        (!/(?:cost|cost_usd|seconds|duration)$/.test(path) && !Number.isSafeInteger(value)));
      const put = (key: keyof UsageAmounts, value: number | undefined) => {
        if (value === undefined) return;
        if (!Number.isFinite(value) || value < 0 || (key !== "providerCostUsd" && key !== "audioSeconds" && !Number.isSafeInteger(value))) invalidAmounts = true;
        else amounts[key] = value;
      };
      const input = counter("usage.input_tokens", "usage.prompt_tokens", "usageMetadata.promptTokenCount", "meta.billed_units.input_tokens") ??
        (["embedding", "rerank"].includes(type) ? counter("usage.total_tokens") : undefined);
      const output = counter("usage.output_tokens", "usage.completion_tokens", "usageMetadata.candidatesTokenCount");
      const cached = counter("usage.cache_read_input_tokens", "usage.input_tokens_details.cached_tokens", "usage.prompt_tokens_details.cached_tokens", "usageMetadata.cachedContentTokenCount");
      const written = counter("usage.cache_creation_input_tokens");
      const thoughts = counter("usageMetadata.thoughtsTokenCount");
      put("inputTokens", input === undefined ? undefined : input + (operation === "messages" ? (cached ?? 0) + (written ?? 0) : 0));
      put("outputTokens", output === undefined ? undefined : output + (thoughts ?? 0));
      put("cachedInputTokens", cached); put("cacheWriteInputTokens", written);
      put("reasoningTokens", counter("usage.output_tokens_details.reasoning_tokens", "usage.completion_tokens_details.reasoning_tokens", "usageMetadata.thoughtsTokenCount"));
      put("imageInputTokens", counter("usage.input_tokens_details.image_tokens", "usage.prompt_tokens_details.image_tokens", "google.image_input_tokens"));
      put("imageOutputTokens", counter("usage.output_tokens_details.image_tokens", "usage.completion_tokens_details.image_tokens", "google.image_output_tokens"));
      if (type === "image") {
        put("images", counter("images"));
        if ((operation === "images" || operation.startsWith("images/")) && amounts.imageOutputTokens === undefined) put("imageOutputTokens", output);
      }
      if (type === "transcription") put("audioSeconds", number("usage.seconds", "duration"));
      if (type === "rerank") put("searches", counter("meta.billed_units.search_units"));
      put("providerCostUsd", number("usage.cost", "usage.cost_usd"));
      const ticks = counter("usage.cost_in_usd_ticks");
      if (kind === "xai" && ticks !== undefined) put("providerCostUsd", ticks / 1e10);
      // Anthropic documents token counting as free; estimates are not consumed inference tokens.
      if (operation === "messages/count_tokens" && kind === "anthropic" && complete) amounts.providerCostUsd = 0;
      const seen = Object.keys(amounts).length > 0;
      const tokens = amounts.inputTokens !== undefined && amounts.outputTokens !== undefined;
      const measured = amounts.providerCostUsd !== undefined || (type === "text" ? tokens :
        type === "image" ? amounts.images !== undefined || amounts.imageOutputTokens !== undefined :
        type === "transcription" ? amounts.audioSeconds !== undefined || tokens :
        type === "rerank" ? amounts.searches !== undefined || amounts.inputTokens !== undefined : amounts.inputTokens !== undefined);
      return { amounts, measurement: !seen ? "unavailable" : invalid || invalidAmounts || !complete || !measured ? "partial" : "reported", complete: complete && !invalid, errorCode };
    },
  };
}

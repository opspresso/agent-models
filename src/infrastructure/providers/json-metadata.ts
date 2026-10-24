import { finished } from "node:stream/promises";
import parser, { type Token } from "stream-json/parser.js";

export interface Metadata {
  numbers: Map<string, number>;
  strings: Map<string, string>;
  arrays: Map<string, number>;
  valid: boolean;
  hasError: boolean;
  rootObject: boolean;
}

const usageKeys = new Set(["input_tokens", "output_tokens", "prompt_tokens", "completion_tokens", "total_tokens", "cache_read_input_tokens",
  "cache_creation_input_tokens", "cost", "cost_usd", "cost_in_usd_ticks", "seconds", "input_tokens_details.cached_tokens",
  "input_tokens_details.image_tokens", "prompt_tokens_details.cached_tokens", "prompt_tokens_details.image_tokens",
  "output_tokens_details.reasoning_tokens", "completion_tokens_details.reasoning_tokens", "completion_tokens_details.image_tokens",
  "output_tokens_details.image_tokens"]);

function numericPath(path: string): boolean {
  const usage = /^(?:response\.|message\.)?usage\.(.+)$/.exec(path);
  if (usage) return usageKeys.has(usage[1]!);
  return /^(?:duration|input_tokens|meta\.billed_units\.(?:input_tokens|search_units)|usageMetadata\.(?:promptTokenCount|candidatesTokenCount|thoughtsTokenCount|cachedContentTokenCount|totalTokenCount))$/.test(path) ||
    /^usageMetadata\.(?:promptTokensDetails|candidatesTokensDetails)\.(?:[0-9]|1[0-5])\.tokenCount$/.test(path);
}
const stringPath = (path: string) => /^(?:type|status|response\.status|choices\.0\.finish_reason|candidates\.0\.finishReason)$/.test(path) ||
  /^usageMetadata\.(?:promptTokensDetails|candidatesTokensDetails)\.(?:[0-9]|1[0-5])\.modality$/.test(path);
const arrayPath = (path: string) => path === "data" || /^choices\.0\.(?:message|delta)\.images$/.test(path);

/** Only bounded counters and status fields are retained; text, image and vector strings are streamed past. */
export function createJsonMetadata() {
  const result: Metadata = { numbers: new Map(), strings: new Map(), arrays: new Map(), valid: true, hasError: false, rootObject: false };
  const stream = parser.asStream({ packValues: false, streamValues: true });
  const complete = finished(stream).catch(() => { result.valid = false; });
  type Frame = { kind: "object" | "array"; path: string[]; key: string; index: number };
  const stack: Frame[] = [];
  let scalar: "key" | "string" | "number" | null = null;
  let buffer = "";
  let retain = false;
  const valuePath = () => {
    const parent = stack.at(-1);
    return parent ? [...parent.path, parent.kind === "array" ? String(parent.index) : parent.key] : [];
  };
  const key = (path: string[]) => path.some(part => part.includes(".")) ? "" : path.join(".");
  const endValue = () => { const parent = stack.at(-1); if (parent?.kind === "array") parent.index++; };
  function observe(token: Token) {
    switch (token.name) {
      case "startObject": case "startArray": {
        const path = valuePath();
        if (!stack.length) result.rootObject = token.name === "startObject";
        if (stack.length >= 64) throw new Error("Response nesting limit");
        if (key(path) === "error" || key(path) === "response.error") result.hasError = true;
        stack.push({ kind: token.name === "startArray" ? "array" : "object", path, key: "", index: 0 });
        break;
      }
      case "endObject": case "endArray": {
        const frame = stack.pop()!;
        if (frame.kind === "array" && arrayPath(key(frame.path))) result.arrays.set(key(frame.path), frame.index);
        endValue();
        break;
      }
      case "startKey": scalar = "key"; buffer = ""; retain = true; break;
      case "endKey": stack.at(-1)!.key = buffer; scalar = null; break;
      case "startString": case "startNumber": {
        const path = key(valuePath());
        if (path === "error" || path === "response.error") result.hasError = true;
        scalar = token.name === "startString" ? "string" : "number"; buffer = "";
        retain = scalar === "string" ? stringPath(path) : numericPath(path);
        break;
      }
      case "stringChunk": case "numberChunk":
        if (retain) {
          buffer += token.value;
          if (buffer.length > 256) throw new Error("Response metadata limit");
        }
        break;
      case "endString": case "endNumber":
        if (retain) {
          const path = key(valuePath());
          if (scalar === "number") result.numbers.set(path, Number(buffer));
          else result.strings.set(path, buffer);
        }
        scalar = null;
        endValue();
        break;
      case "trueValue": case "falseValue":
        if (["error", "response.error"].includes(key(valuePath()))) result.hasError = true;
        endValue(); break;
      case "nullValue": endValue(); break;
    }
  }
  stream.on("data", (token: Token) => {
    try { observe(token); }
    catch { result.valid = false; stream.destroy(); }
  });
  return {
    async write(value: string): Promise<void> {
      if (!result.valid || stream.destroyed) return;
      await new Promise<void>(resolve => stream.write(value, error => { if (error) result.valid = false; resolve(); }));
    },
    async end(): Promise<Metadata> {
      if (!stream.destroyed) stream.end();
      await complete;
      return result;
    },
    cancel() { result.valid = false; stream.destroy(); },
  };
}

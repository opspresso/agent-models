import { RouterError } from "./errors.ts";
import type { Operation } from "./types.ts";
import type { InferenceBody } from "./transport.ts";

/** Shared provider credentials never grant access to another caller's hosted files or conversation. */
export function assertIndependentContext(body: Record<string, unknown>, operation: Operation): void {
  const object = (value: unknown): Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
  const refuse = () => { throw new RouterError("provider_state_forbidden", 403, "Send complete inline context; external media and hosted provider resources are not available through this router"); };
  const inlineUrl = (value: unknown) => {
    const url = typeof value === "string" ? value : object(value).url;
    if (typeof url !== "string" || !/^data:[^,\r\n]{1,200};base64,/i.test(url)) refuse();
  };
  const media = (value: unknown): void => {
    if (Array.isArray(value)) { for (const entry of value) media(entry); return; }
    if (typeof value === "string") { inlineUrl(value); return; }
    const item = object(value);
    if (item.file_url != null || item.file_id != null) refuse();
    for (const reference of [item.url, item.image_url, item.audio_url]) if (reference != null) inlineUrl(reference);
  };
  if (body.previous_response_id != null || body.conversation != null || body.container != null || body.cachedContent != null || body.cached_content != null || body.background === true || body.store === true) refuse();
  if (operation === "responses" && typeof body.prompt === "object" && body.prompt !== null) refuse();
  media(body);
  for (const reference of [body.image, body.images, body.mask, body.input_references]) if (reference != null) media(reference);
  if (operation === "audio/transcriptions") {
    if (body.file_url != null) refuse();
    for (const reference of [body.file, body.audio_url, body.url]) if (reference != null) media(reference);
  }
  if (Array.isArray(body.tools)) {
    const allowed = (value: unknown): boolean => {
      const tool = object(value);
      if (operation === "messages" || operation === "messages/count_tokens") return tool.type == null || tool.type === "custom";
      if (operation === "generateContent" || operation === "streamGenerateContent") return Object.keys(tool).every(key => key === "functionDeclarations" || key === "function_declarations");
      if (tool.type === "namespace") return Array.isArray(tool.tools) && tool.tools.every(child => ["function", "custom"].includes(String(object(child).type)));
      return ["function", "custom"].includes(String(tool.type));
    };
    if (!body.tools.every(allowed)) refuse();
  }
  // ProtoJSON accepts camelCase and original snake_case names for the same Google fields.
  const pending = [body.input, body.messages, body.contents, body.systemInstruction, body.system_instruction];
  while (pending.length) {
    const value = pending.pop();
    if (Array.isArray(value)) { for (const child of value) pending.push(child); continue; }
    const item = object(value);
    const source = object(item.source);
    media(object(item.file));
    media(object(item.audio));
    if (item.type === "item_reference" || (item.id != null && item.type == null && item.role == null) || object(item.audio).id != null ||
        item.file_id != null || item.file_url != null || object(item.file).file_id != null || source.file_id != null || source.type === "file" ||
        source.type === "url" || source.url != null || item.fileData != null || item.file_data != null) refuse();
    for (const reference of [item.image_url, item.audio_url, object(item.input_audio).url]) if (reference != null) inlineUrl(reference);
    // Tool argument strings and JSON remain caller data, not protocol references.
    for (const child of [item.content, item.output, item.parts, source.content]) if (child && typeof child === "object") pending.push(child);
  }
}

/** Multipart media is uploaded bytes, never a URL or an account-owned file handle. */
export function assertIndependentMultipartContext(parts: Extract<InferenceBody, { kind: "multipart" }>["parts"], operation: Operation): void {
  const fields: Record<string, string> = Object.create(null);
  for (const part of parts) {
    if (typeof part.value !== "string") continue;
    if (/^(?:files?|mask|images?)(?:\[\d*\])?$/.test(part.name)) throw new RouterError("inline_media_required", 400, "Upload media bytes in multipart file fields");
    assertIndependentContext({ [part.name.replace(/\[\d*\]$/, "")]: part.value }, operation);
    fields[part.name] = part.value;
  }
  assertIndependentContext(fields, operation);
}

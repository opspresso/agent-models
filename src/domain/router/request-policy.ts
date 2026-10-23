import { RouterError } from "./errors.ts";
import type { Operation } from "./types.ts";

/** Shared provider credentials never grant access to another caller's hosted files or conversation. */
export function assertIndependentContext(body: Record<string, unknown>, operation: Operation): void {
  const object = (value: unknown): Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
  const refuse = () => { throw new RouterError("provider_state_forbidden", 403, "Send complete inline context; hosted provider resources are not available through this router"); };
  if (body.previous_response_id != null || body.conversation != null || body.container != null || body.cachedContent != null || body.background === true || body.store === true) refuse();
  if (operation === "responses" && typeof body.prompt === "object" && body.prompt !== null) refuse();
  if (Array.isArray(body.tools)) {
    const allowed = (value: unknown): boolean => {
      const tool = object(value);
      if (operation === "messages" || operation === "messages/count_tokens") return tool.type == null || tool.type === "custom";
      if (operation === "generateContent" || operation === "streamGenerateContent") return Object.keys(tool).every(key => key === "functionDeclarations");
      if (tool.type === "namespace") return Array.isArray(tool.tools) && tool.tools.every(child => ["function", "custom"].includes(String(object(child).type)));
      return ["function", "custom"].includes(String(tool.type));
    };
    if (!body.tools.every(allowed)) refuse();
  }
  const pending = [body.input, body.messages, body.contents];
  while (pending.length) {
    const value = pending.pop();
    if (Array.isArray(value)) { for (const child of value) pending.push(child); continue; }
    const item = object(value);
    const source = object(item.source);
    if (item.type === "item_reference" || (item.id != null && item.type == null && item.role == null) || object(item.audio).id != null ||
        item.file_id != null || object(item.file).file_id != null || source.file_id != null || source.type === "file" || item.fileData != null) refuse();
    // Tool argument strings and JSON remain caller data, not protocol references.
    for (const child of [item.content, item.output, item.parts, source.content]) if (child && typeof child === "object") pending.push(child);
  }
}

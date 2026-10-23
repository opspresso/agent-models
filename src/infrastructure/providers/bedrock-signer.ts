import { createHash, createHmac } from "node:crypto";
import { defaultProvider } from "@aws-sdk/credential-provider-node";
import { SignatureV4 } from "@smithy/signature-v4";
import { RouterError } from "../../domain/router/errors.ts";

export type RequestSigner = (input: string | URL | Request, init?: RequestInit) => Promise<Request>;
function bytes(value: string | ArrayBuffer | ArrayBufferView): Buffer {
  return typeof value === "string" ? Buffer.from(value) : ArrayBuffer.isView(value)
    ? Buffer.from(value.buffer, value.byteOffset, value.byteLength) : Buffer.from(value);
}
class NodeHash {
  private readonly hash: ReturnType<typeof createHash> | ReturnType<typeof createHmac>;
  constructor(secret?: string | ArrayBuffer | ArrayBufferView) { this.hash = secret === undefined ? createHash("sha256") : createHmac("sha256", bytes(secret)); }
  update(value: string | ArrayBuffer | ArrayBufferView) { this.hash.update(bytes(value)); }
  async digest(): Promise<Uint8Array> { return new Uint8Array(this.hash.digest()); }
}

/** Signing completes before inference dispatch is recorded; credential-chain failures incur no model call. */
export function createBedrockSigner(options: { credentials?: ReturnType<typeof defaultProvider> } = {}): RequestSigner {
  const signer = new SignatureV4({ service: "bedrock", region: "us-east-1", credentials: options.credentials ?? defaultProvider(), sha256: NodeHash });
  return async (input, init) => {
    const body = init?.body ?? (input instanceof Request ? input.body : undefined);
    if (body != null && typeof body !== "string" && !ArrayBuffer.isView(body) && !(body instanceof ArrayBuffer)) throw new RouterError("unsupported_protocol", 400, "Bedrock signing requires a buffered body");
    const request = new Request(input, init);
    const url = new URL(request.url);
    const region = url.hostname.split(".").find(label => /^[a-z]{2}(?:-[a-z]+)+-\d$/.test(label));
    if (!region) throw new RouterError("invalid_provider", 400, "Bedrock endpoint must identify its AWS region");
    const query: Record<string, string | string[]> = Object.create(null);
    for (const name of new Set(url.searchParams.keys())) {
      const values = url.searchParams.getAll(name); query[name] = values.length === 1 ? values[0]! : values;
    }
    const signed = await signer.sign({ method: request.method, protocol: url.protocol, hostname: url.hostname,
      ...(url.port ? { port: Number(url.port) } : {}), path: url.pathname, query,
      headers: { ...Object.fromEntries(request.headers), host: url.host }, body: body == null ? "" : typeof body === "string" ? body : bytes(body) }, { signingRegion: region });
    return new Request(request, { headers: signed.headers });
  };
}

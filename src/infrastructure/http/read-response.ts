/** Bound allocation before decoding JSON; provider and identity responses are untrusted bytes. */
export async function readResponseBytes(response: Response, limit: number): Promise<Uint8Array<ArrayBuffer>> {
  if (!response.body) throw new Error("Response has no body");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  let ended = false;
  try {
    while (true) {
      const value = await reader.read();
      if (value.done) { ended = true; break; }
      size += value.value.byteLength;
      if (size > limit) throw new Error("Response exceeds its byte limit");
      chunks.push(value.value);
    }
    const buffer = Buffer.concat(chunks);
    return new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength);
  } finally {
    try { if (!ended) await reader.cancel(); }
    finally { reader.releaseLock(); }
  }
}

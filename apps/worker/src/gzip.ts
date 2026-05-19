import { LIMITS } from "@workspace-viewer/protocol";

export async function gunzipJson(payload: ArrayBuffer, expectedBytes: number): Promise<unknown> {
  if (payload.byteLength > LIMITS.relay.maxCompressedPayloadBytes) {
    throw new Error("compressed payload too large");
  }
  if (expectedBytes > LIMITS.relay.maxUncompressedPayloadBytes) {
    throw new Error("declared uncompressed payload too large");
  }

  const decompressed = await new Response(
    new Response(payload).body?.pipeThrough(new DecompressionStream("gzip"))
  ).arrayBuffer();

  if (decompressed.byteLength > LIMITS.relay.maxUncompressedPayloadBytes) {
    throw new Error("uncompressed payload too large");
  }

  const text = new TextDecoder().decode(decompressed);
  return JSON.parse(text);
}

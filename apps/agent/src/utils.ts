import { open, stat } from "node:fs/promises";
import { createReadStream } from "node:fs";
import { createInterface } from "node:readline";
import { extname } from "node:path";
import { gzipSync } from "node:zlib";
import { LIMITS } from "@workspace-viewer/protocol";

const languageByExtension = new Map<string, string>([
  [".ts", "typescript"],
  [".tsx", "typescript"],
  [".js", "javascript"],
  [".jsx", "javascript"],
  [".json", "json"],
  [".md", "markdown"],
  [".py", "python"],
  [".rs", "rust"],
  [".go", "go"],
  [".java", "java"],
  [".kt", "kotlin"],
  [".css", "css"],
  [".html", "html"],
  [".sql", "sql"],
  [".yml", "yaml"],
  [".yaml", "yaml"]
]);

export function detectLanguage(filePath: string): string | undefined {
  return languageByExtension.get(extname(filePath).toLowerCase());
}

export async function isProbablyBinary(filePath: string): Promise<boolean> {
  const handle = await open(filePath, "r");
  try {
    const buffer = Buffer.alloc(LIMITS.searchFile.binaryProbeBytes);
    const result = await handle.read(buffer, 0, buffer.length, 0);
    for (let index = 0; index < result.bytesRead; index += 1) {
      if (buffer[index] === 0) return true;
    }
    return false;
  } finally {
    await handle.close();
  }
}

export async function countLines(filePath: string): Promise<number> {
  let count = 0;
  const rl = createInterface({ input: createReadStream(filePath), crlfDelay: Infinity });
  for await (const _ of rl) count += 1;
  return count;
}

export async function fileSize(filePath: string): Promise<number> {
  return (await stat(filePath)).size;
}

export function gzipJson(value: unknown): { compressed: Buffer; uncompressedBytes: number } {
  const raw = Buffer.from(JSON.stringify(value), "utf8");
  const compressed = gzipSync(raw);
  return { compressed, uncompressedBytes: raw.byteLength };
}

export function jsonByteLength(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value), "utf8");
}

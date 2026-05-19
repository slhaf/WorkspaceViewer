export async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

export async function hashAgentToken(token: string): Promise<string> {
  return `sha256:${await sha256Hex(token)}`;
}

export async function verifyAgentToken(token: string, storedHash: string): Promise<boolean> {
  if (storedHash.startsWith("sha256:")) {
    return await hashAgentToken(token) === storedHash;
  }
  return token === storedHash;
}

export async function verifyPasswordHash(password: string, storedHash: string): Promise<boolean> {
  if (storedHash.startsWith("sha256:")) {
    return constantTimeEqual(`sha256:${await sha256Hex(password)}`, storedHash);
  }
  return false;
}

function constantTimeEqual(left: string, right: string): boolean {
  if (left.length !== right.length) return false;
  let diff = 0;
  for (let index = 0; index < left.length; index += 1) {
    diff |= left.charCodeAt(index) ^ right.charCodeAt(index);
  }
  return diff === 0;
}

export function randomUrlSafe(bytes = 32): string {
  const data = new Uint8Array(bytes);
  crypto.getRandomValues(data);
  return btoa(String.fromCharCode(...data))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replaceAll("=", "");
}

export async function signValue(value: string, secret: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const signature = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(value));
  const encoded = btoa(String.fromCharCode(...new Uint8Array(signature)))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replaceAll("=", "");
  return `${value}.${encoded}`;
}

export async function verifySignedValue(signedValue: string, secret: string): Promise<string | null> {
  const index = signedValue.lastIndexOf(".");
  if (index <= 0) return null;
  const value = signedValue.slice(0, index);
  return await signValue(value, secret) === signedValue ? value : null;
}

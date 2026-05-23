import {
  LIMITS,
  type Context7ToolName,
  context7InputSchemas,
  context7ResultSchemas,
  workspaceError
} from "@workspace-viewer/protocol";
import type { Env } from "./env.js";

const DEFAULT_CONTEXT7_BASE_URL = "https://context7.com";

export async function callContext7Tool(
  env: Env,
  _userId: string,
  name: Context7ToolName,
  args: unknown
): Promise<unknown> {
  switch (name) {
    case "context7ResolveLibraryId":
      return context7ResolveLibraryId(env, context7InputSchemas.context7ResolveLibraryId.parse(args));
    case "context7QueryDocs":
      return context7QueryDocs(env, context7InputSchemas.context7QueryDocs.parse(args));
  }
}

async function context7ResolveLibraryId(
  env: Env,
  input: { libraryName: string; query: string; maxResults?: number | undefined }
) {
  const maxResults = Math.min(input.maxResults ?? LIMITS.context7.maxResults, LIMITS.context7.maxResults);
  const payload = await fetchContext7Json(env, "/api/v2/libs/search", {
    libraryName: input.libraryName,
    query: input.query
  });
  const candidates = extractArray(payload)
    .map(normalizeLibraryCandidate)
    .filter((candidate): candidate is NonNullable<ReturnType<typeof normalizeLibraryCandidate>> => Boolean(candidate));
  const truncated = candidates.length > maxResults;
  const results = candidates.slice(0, maxResults);
  const selected = results[0]
    ? { libraryId: results[0].libraryId, reason: "Top Context7 search result." }
    : undefined;

  return context7ResultSchemas.context7ResolveLibraryId.parse({
    results,
    selected,
    truncated
  });
}

async function context7QueryDocs(
  env: Env,
  input: {
    libraryId: string;
    query: string;
    type?: "json" | "txt" | undefined;
    fast?: boolean | undefined;
    maxChars?: number | undefined;
  }
) {
  const type = input.type ?? "json";
  const fast = input.fast ?? true;
  const maxChars = Math.min(input.maxChars ?? LIMITS.context7.defaultMaxChars, LIMITS.context7.maxChars);
  const response = await fetchContext7(env, "/api/v2/context", {
    libraryId: input.libraryId,
    query: input.query,
    type,
    fast: String(fast)
  });

  if (type === "txt") {
    const { value, truncated } = truncateString(await response.text(), maxChars);
    return context7ResultSchemas.context7QueryDocs.parse({
      libraryId: input.libraryId,
      query: input.query,
      type,
      content: value,
      truncated
    });
  }

  const payload = await response.json<unknown>();
  const normalized = normalizeContextPayload(payload, maxChars);
  return context7ResultSchemas.context7QueryDocs.parse({
    libraryId: input.libraryId,
    query: input.query,
    type,
    ...normalized
  });
}

async function fetchContext7Json(env: Env, path: string, params: Record<string, string>): Promise<unknown> {
  const response = await fetchContext7(env, path, params);
  return response.json<unknown>();
}

async function fetchContext7(env: Env, path: string, params: Record<string, string>): Promise<Response> {
  if (!env.CONTEXT7_API_KEY) {
    throw workspaceError("CONTEXT7_NOT_CONFIGURED", "CONTEXT7_API_KEY is not configured");
  }

  const base = (env.CONTEXT7_BASE_URL ?? DEFAULT_CONTEXT7_BASE_URL).replace(/\/$/, "");
  const url = new URL(`${base}${path}`);
  for (const [key, value] of Object.entries(params)) {
    url.searchParams.set(key, value);
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), LIMITS.context7.timeoutMs);
  try {
    const response = await fetch(url, {
      headers: {
        authorization: `Bearer ${env.CONTEXT7_API_KEY}`,
        accept: "application/json, text/plain;q=0.9"
      },
      signal: controller.signal
    });

    if (!response.ok) {
      throw mapContext7Error(response.status);
    }
    return response;
  } catch (error) {
    if (isWorkspaceErrorObject(error)) throw error;
    if (error instanceof DOMException && error.name === "AbortError") {
      throw workspaceError("CONTEXT7_UPSTREAM_ERROR", "Context7 request timed out");
    }
    throw workspaceError("CONTEXT7_UPSTREAM_ERROR", error instanceof Error ? error.message : "Context7 request failed");
  } finally {
    clearTimeout(timeout);
  }
}

function mapContext7Error(status: number) {
  if (status === 401 || status === 403) {
    return workspaceError("CONTEXT7_AUTH_FAILED", "Context7 authentication failed", { status });
  }
  if (status === 429) {
    return workspaceError("CONTEXT7_RATE_LIMITED", "Context7 rate limit exceeded", { status });
  }
  return workspaceError("CONTEXT7_UPSTREAM_ERROR", "Context7 upstream request failed", { status });
}

function isWorkspaceErrorObject(error: unknown): boolean {
  return Boolean(error && typeof error === "object" && "code" in error && "message" in error);
}

function extractArray(value: unknown): unknown[] {
  if (Array.isArray(value)) return value;
  if (!value || typeof value !== "object") return [];
  const record = value as Record<string, unknown>;
  for (const key of ["results", "libraries", "items", "data"]) {
    if (Array.isArray(record[key])) return record[key];
  }
  return [];
}

function normalizeLibraryCandidate(value: unknown): {
  libraryId: string;
  title?: string;
  description?: string;
  totalSnippets?: number;
  trustScore?: number;
  tokens?: number;
} | undefined {
  if (!value || typeof value !== "object") return undefined;
  const record = value as Record<string, unknown>;
  const libraryId = firstString(record.libraryId, record.id, record.context7CompatibleLibraryID);
  if (!libraryId) return undefined;
  const candidate: {
    libraryId: string;
    title?: string;
    description?: string;
    totalSnippets?: number;
    trustScore?: number;
    tokens?: number;
  } = { libraryId };
  const title = firstString(record.title, record.name);
  const description = firstString(record.description);
  const totalSnippets = firstNumber(record.totalSnippets, record.snippets, record.codeSnippets);
  const trustScore = firstNumber(record.trustScore, record.score);
  const tokens = firstNumber(record.tokens);
  if (title) candidate.title = title;
  if (description) candidate.description = description;
  if (totalSnippets !== undefined) candidate.totalSnippets = totalSnippets;
  if (trustScore !== undefined) candidate.trustScore = trustScore;
  if (tokens !== undefined) candidate.tokens = tokens;
  return candidate;
}

function normalizeContextPayload(payload: unknown, maxChars: number): {
  content?: string;
  codeSnippets?: Array<{ title?: string; description?: string; language?: string; code?: string; source?: string }>;
  infoSnippets?: Array<{ title?: string; breadcrumb?: string; content: string; source?: string }>;
  rules?: unknown;
  truncated: boolean;
} {
  const record = payload && typeof payload === "object" ? payload as Record<string, unknown> : {};
  const codeSnippets = collectSnippetArray(record, ["codeSnippets", "code_snippets", "snippets"])
    .map(normalizeCodeSnippet)
    .filter((snippet): snippet is NonNullable<ReturnType<typeof normalizeCodeSnippet>> => Boolean(snippet));
  const infoSnippets = collectSnippetArray(record, ["infoSnippets", "info_snippets", "topics", "documentation"])
    .map(normalizeInfoSnippet)
    .filter((snippet): snippet is NonNullable<ReturnType<typeof normalizeInfoSnippet>> => Boolean(snippet));
  const rawContent = firstString(record.content, record.text);
  let truncated = false;
  let remaining = maxChars;
  const result: ReturnType<typeof normalizeContextPayload> = {
    truncated: false
  };

  if (rawContent) {
    const trimmed = truncateString(rawContent, remaining);
    result.content = trimmed.value;
    truncated ||= trimmed.truncated;
    remaining -= trimmed.value.length;
  }

  const normalizedCode = truncateCodeSnippets(codeSnippets, Math.max(0, remaining));
  if (normalizedCode.values.length > 0) result.codeSnippets = normalizedCode.values;
  truncated ||= normalizedCode.truncated;
  remaining -= normalizedCode.usedChars;

  const normalizedInfo = truncateInfoSnippets(infoSnippets, Math.max(0, remaining));
  if (normalizedInfo.values.length > 0) result.infoSnippets = normalizedInfo.values;
  truncated ||= normalizedInfo.truncated;

  if ("rules" in record) result.rules = record.rules;
  result.truncated = truncated;
  return result;
}

function collectSnippetArray(record: Record<string, unknown>, keys: string[]): unknown[] {
  for (const key of keys) {
    if (Array.isArray(record[key])) return record[key];
  }
  return [];
}

function normalizeCodeSnippet(value: unknown) {
  if (!value || typeof value !== "object") return undefined;
  const record = value as Record<string, unknown>;
  const code = firstString(record.code, record.content);
  if (!code) return undefined;
  const snippet: { title?: string; description?: string; language?: string; code: string; source?: string } = { code };
  const title = firstString(record.title);
  const description = firstString(record.description);
  const language = firstString(record.language, record.lang);
  const source = firstString(record.source, record.sourceUrl, record.url);
  if (title) snippet.title = title;
  if (description) snippet.description = description;
  if (language) snippet.language = language;
  if (source) snippet.source = source;
  return snippet;
}

function normalizeInfoSnippet(value: unknown) {
  if (!value || typeof value !== "object") return undefined;
  const record = value as Record<string, unknown>;
  const content = firstString(record.content, record.text, record.description);
  if (!content) return undefined;
  const snippet: { title?: string; breadcrumb?: string; content: string; source?: string } = { content };
  const title = firstString(record.title);
  const breadcrumb = firstString(record.breadcrumb);
  const source = firstString(record.source, record.sourceUrl, record.url);
  if (title) snippet.title = title;
  if (breadcrumb) snippet.breadcrumb = breadcrumb;
  if (source) snippet.source = source;
  return snippet;
}

function truncateCodeSnippets(
  snippets: Array<{ title?: string; description?: string; language?: string; code?: string; source?: string }>,
  maxChars: number
) {
  let usedChars = 0;
  let truncated = false;
  const values = [];
  for (const snippet of snippets) {
    if (usedChars >= maxChars) {
      truncated = true;
      break;
    }
    const code = snippet.code ?? "";
    const trimmed = truncateString(code, maxChars - usedChars);
    values.push({ ...snippet, code: trimmed.value });
    usedChars += trimmed.value.length;
    truncated ||= trimmed.truncated;
  }
  return { values, usedChars, truncated };
}

function truncateInfoSnippets(
  snippets: Array<{ title?: string; breadcrumb?: string; content: string; source?: string }>,
  maxChars: number
) {
  let usedChars = 0;
  let truncated = false;
  const values = [];
  for (const snippet of snippets) {
    if (usedChars >= maxChars) {
      truncated = true;
      break;
    }
    const trimmed = truncateString(snippet.content, maxChars - usedChars);
    values.push({ ...snippet, content: trimmed.value });
    usedChars += trimmed.value.length;
    truncated ||= trimmed.truncated;
  }
  return { values, usedChars, truncated };
}

function truncateString(value: string, maxChars: number): { value: string; truncated: boolean } {
  if (value.length <= maxChars) return { value, truncated: false };
  return { value: value.slice(0, Math.max(0, maxChars)), truncated: true };
}

function firstString(...values: unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value === "string" && value.length > 0) return value;
  }
  return undefined;
}

function firstNumber(...values: unknown[]): number | undefined {
  for (const value of values) {
    if (typeof value === "number" && Number.isFinite(value)) return value;
  }
  return undefined;
}

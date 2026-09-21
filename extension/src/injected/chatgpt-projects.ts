import type { ProviderProject } from "../shared/types";
import { projectId } from "../providers/chatgpt-project";
import { readBoundedResponse } from "./response-observer";

type RecordValue = Record<string, unknown>;
const record = (value: unknown): RecordValue | undefined =>
  value !== null && typeof value === "object" && !Array.isArray(value) ? value as RecordValue : undefined;
const MAX_PAGES = 100;
const MAX_ITEMS = 10_000;

export interface ProjectConversation {
  project: ProviderProject;
  key: string;
  fingerprint: string;
}

/** Bounded same-origin GETs. Never persist authorization or log response bodies. */
export function chatGPTReader(fetcher: typeof fetch, headers: HeadersInit,
  sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))) {
  return async (path: string): Promise<{ response: Response; text: string; json: unknown }> => {
    const url = new URL(path, "https://chatgpt.com");
    if (url.origin !== "https://chatgpt.com") throw new Error("Cross-origin history request rejected.");
    for (let attempt = 0; attempt < 3; attempt++) {
      const response = await fetcher(url.toString(), {
        method: "GET", credentials: "include", headers, redirect: "error", signal: AbortSignal.timeout(30_000)
      });
      if (response.ok) {
        const text = await readBoundedResponse(response, undefined, 30_000);
        return { response, text, json: JSON.parse(text) };
      }
      void response.body?.cancel().catch(() => undefined);
      if ((response.status !== 429 && response.status < 500) || attempt === 2) {
        throw new Error(`ChatGPT history request failed (${response.status}); sync remains retryable.`);
      }
      const retry = response.headers.get("retry-after");
      const wait = retry && /^\d+$/.test(retry) ? Number(retry) * 1000 : 1000 * 2 ** attempt;
      // Long rate limits are surfaced rather than ignored or left running indefinitely.
      if (wait > 30_000) throw new Error("ChatGPT rate limit: retry history sync later.");
      await sleep(wait);
    }
    throw new Error("ChatGPT history retry limit reached.");
  };
}

function page(value: unknown): { items: unknown[]; cursor: string | null } {
  const root = record(value);
  if (!root || !Array.isArray(root.items) ||
      !(root.cursor === null || typeof root.cursor === "string" || typeof root.cursor === "number")) {
    throw new Error("ChatGPT project history format changed; pagination cannot be verified.");
  }
  return { items: root.items, cursor: root.cursor === null ? null : String(root.cursor) };
}

async function* pages(read: (path: string) => Promise<{ json: unknown }>, path: string, first?: string) {
  let cursor = first;
  const visited = new Set<string>();
  let count = 0;
  for (let i = 0; i < MAX_PAGES; i++) {
    const url = new URL(path, "https://chatgpt.com");
    if (cursor !== undefined) url.searchParams.set("cursor", cursor);
    const result = page((await read(url.toString())).json);
    count += result.items.length;
    if (count > MAX_ITEMS) throw new Error("ChatGPT project history item limit reached; sync incomplete.");
    yield result.items;
    if (result.cursor === null) return;
    if (visited.has(result.cursor) || result.cursor === cursor) throw new Error("ChatGPT project pagination repeated a cursor.");
    visited.add(result.cursor);
    cursor = result.cursor;
  }
  throw new Error("ChatGPT project pagination limit reached; sync incomplete.");
}

function project(value: unknown): ProviderProject | undefined {
  const item = record(value);
  const wrapper = record(item?.gizmo);
  const gizmo = record(wrapper?.gizmo) ?? wrapper;
  if (!gizmo || !projectId(gizmo.id)) return undefined; // Excludes custom GPTs.
  const display = record(gizmo.display);
  const name = display?.name ?? gizmo.name;
  const files = wrapper?.files;
  if ((typeof name === "string" && name.length > 120) ||
      (typeof gizmo.instructions === "string" && gizmo.instructions.length > 100_000) ||
      (Array.isArray(files) && files.length > 500)) {
    throw new Error("ChatGPT project metadata exceeds capture limits; context was not truncated.");
  }
  return {
    id: gizmo.id,
    ...(typeof name === "string" ? { name: name.slice(0, 120) } : {}),
    ...(typeof gizmo.workspace_id === "string" ? { workspace_id: gizmo.workspace_id.slice(0, 255) } : {}),
    ...(typeof gizmo.instructions === "string" ? { instructions: gizmo.instructions.slice(0, 100_000) } : {}),
    ...(Array.isArray(files) ? { files: files.map((file) => {
      const f = record(file);
      if (!f || typeof f.file_id !== "string" || !f.file_id || f.file_id.length > 255 ||
          typeof f.name !== "string" || f.name.length > 500) {
        throw new Error("ChatGPT project file metadata format changed; references were not discarded.");
      }
      return { id: f.file_id, name: f.name };
    }) } : {})
  };
}

async function fingerprint(value: unknown): Promise<string> {
  const bytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify(value)));
  return Array.from(new Uint8Array(bytes), (b) => b.toString(16).padStart(2, "0")).join("");
}

/** No global chat watermark: project pagination is an independent index. */
export async function discoverChatGPTProjects(read: (path: string) => Promise<{ json: unknown }>, accountScope = "unknown"): Promise<Map<string, ProjectConversation>> {
  const projects = new Map<string, ProviderProject>();
  for await (const items of pages(read, "/backend-api/gizmos/snorlax/sidebar?conversations_per_gizmo=0")) {
    for (const item of items) {
      const parsed = project(item);
      if (parsed) projects.set(parsed.id, parsed);
      else {
        const wrapper = record(record(item)?.gizmo);
        const raw = record(wrapper?.gizmo) ?? wrapper;
        if (typeof raw?.id !== "string" || raw.id.startsWith("g-p-")) {
          throw new Error("ChatGPT project index contains an invalid item.");
        }
      }
    }
  }
  const conversations = new Map<string, ProjectConversation>();
  for (const p of projects.values()) {
    const projectDigest = await fingerprint(p);
    for await (const items of pages(read, `/backend-api/gizmos/${encodeURIComponent(p.id)}/conversations`, "0")) {
      for (const value of items) {
        const item = record(value);
        if (!item || typeof item.id !== "string" || !/^[a-zA-Z0-9_-]{1,255}$/.test(item.id)) {
          throw new Error("ChatGPT project conversation identity missing; sync incomplete.");
        }
        const previous = conversations.get(item.id);
        if (previous && previous.project.id !== p.id) throw new Error("ChatGPT project membership changed during sync; retry.");
        conversations.set(item.id, {
          project: p, key: `${accountScope}/${p.workspace_id ?? ""}/${p.id}/${item.id}`,
          // No timestamp means no reliable cache hit; refresh on every run.
          fingerprint: typeof item.update_time === "string" || typeof item.update_time === "number"
            ? await fingerprint([projectDigest, item.update_time]) : ""
        });
        if (conversations.size > MAX_ITEMS) throw new Error("ChatGPT project conversation limit reached; sync incomplete.");
      }
    }
  }
  return conversations;
}

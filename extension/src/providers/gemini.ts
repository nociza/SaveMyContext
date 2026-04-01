import type { CapturedNetworkEvent, NormalizedSessionSnapshot } from "../shared/types";
import type { IProviderScraper } from "./provider";
import {
  collectStrings,
  dedupeMessages,
  extractStructuredCandidates,
  findStringByKeys,
  pickLikelyText,
  sessionIdFromPageUrl,
  stableId
} from "./helpers";

function parseRequestBody(body?: string): unknown[] {
  if (!body) {
    return [];
  }

  const candidates = [...extractStructuredCandidates(body)];
  try {
    const params = new URLSearchParams(body);
    const encoded = params.get("f.req");
    if (encoded) {
      const parsed = JSON.parse(encoded);
      candidates.push(parsed);
    }
  } catch {
    // Gemini request formats vary and often are not clean URLSearchParams payloads.
  }

  return candidates;
}

export class GeminiScraper implements IProviderScraper {
  readonly provider = "gemini" as const;

  matches(event: CapturedNetworkEvent): boolean {
    return /gemini\.google\.com/.test(new URL(event.url).hostname) && /batchexecute|BardFrontendService|StreamGenerate|conversation/i.test(event.url);
  }

  parse(event: CapturedNetworkEvent): NormalizedSessionSnapshot | null {
    const requestCandidates = [
      event.requestBody?.json,
      ...parseRequestBody(event.requestBody?.text)
    ].filter(Boolean);
    const responseCandidates = [
      event.response.json,
      ...extractStructuredCandidates(event.response.text)
    ].filter(Boolean);

    const title =
      findStringByKeys(responseCandidates, ["title", "conversationTitle"]) ??
      findStringByKeys(requestCandidates, ["title", "conversationTitle"]);
    const externalSessionId =
      findStringByKeys(responseCandidates, ["conversationId", "conversation_id", "chat_id"]) ??
      findStringByKeys(requestCandidates, ["conversationId", "conversation_id", "chat_id"]) ??
      sessionIdFromPageUrl(event.pageUrl) ??
      stableId("gemini-session", event.pageUrl);

    const prompt = pickLikelyText(requestCandidates.flatMap((value) => collectStrings(value)), false);
    const reply = pickLikelyText(responseCandidates.flatMap((value) => collectStrings(value)), true);

    const messages = dedupeMessages(
      [
        prompt
          ? {
              id: stableId("gemini-user", `${event.requestId}:${prompt}`),
              role: "user" as const,
              content: prompt,
              occurredAt: event.capturedAt,
              raw: requestCandidates[0]
            }
          : null,
        reply
          ? {
              id: stableId("gemini-assistant", `${event.requestId}:${reply}`),
              role: "assistant" as const,
              content: reply,
              occurredAt: event.capturedAt,
              raw: responseCandidates[0]
            }
          : null
      ].filter(Boolean) as NonNullable<NormalizedSessionSnapshot["messages"][number]>[]
    );

    if (!messages.length) {
      return null;
    }

    return {
      provider: this.provider,
      externalSessionId,
      title,
      sourceUrl: event.pageUrl,
      capturedAt: event.capturedAt,
      messages
    };
  }
}


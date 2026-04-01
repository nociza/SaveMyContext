type ProviderName = "chatgpt" | "gemini" | "grok";

const OBSERVER_FLAG = "__TSMC_NETWORK_OBSERVER__";
const MAX_CAPTURE_SIZE = 1_500_000;
const INTERESTING_PATH = /backend-api|conversation|conversations|BardFrontendService|StreamGenerate|batchexecute|app-chat|grok|chat/i;

interface CapturedBody {
  text?: string;
  json?: unknown;
}

interface CapturedNetworkEvent {
  source: "tsmc-network-observer";
  providerHint?: ProviderName;
  pageUrl: string;
  requestId: string;
  method: string;
  url: string;
  capturedAt: string;
  requestBody?: CapturedBody;
  response: {
    status: number;
    ok: boolean;
    contentType?: string;
    text: string;
    json?: unknown;
  };
}

interface TrackedXHR extends XMLHttpRequest {
  __tsmcMethod?: string;
  __tsmcUrl?: string;
}

function safeJsonParse(text?: string): unknown {
  if (!text) {
    return undefined;
  }
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

function truncate(value?: string): string | undefined {
  if (!value) {
    return undefined;
  }
  return value.length > MAX_CAPTURE_SIZE ? value.slice(0, MAX_CAPTURE_SIZE) : value;
}

function providerHintFromUrl(url: string): ProviderName | undefined {
  try {
    const hostname = new URL(url, location.href).hostname;
    if (/chatgpt\.com|chat\.openai\.com/.test(hostname)) {
      return "chatgpt";
    }
    if (/gemini\.google\.com/.test(hostname)) {
      return "gemini";
    }
    if (/grok\.com|x\.com/.test(hostname)) {
      return "grok";
    }
  } catch {
    return undefined;
  }
  return undefined;
}

function shouldCapture(url: string): boolean {
  try {
    const resolved = new URL(url, location.href);
    return INTERESTING_PATH.test(resolved.pathname + resolved.search);
  } catch {
    return false;
  }
}

function postCapture(capture: Omit<CapturedNetworkEvent, "source">): void {
  window.postMessage(
    {
      source: "tsmc-network-observer",
      payload: {
        ...capture,
        source: "tsmc-network-observer"
      } satisfies CapturedNetworkEvent
    },
    window.location.origin
  );
}

async function serializeBody(body: unknown): Promise<CapturedBody | undefined> {
  if (!body) {
    return undefined;
  }

  if (typeof body === "string") {
    const text = truncate(body);
    return {
      text,
      json: safeJsonParse(text)
    };
  }

  if (body instanceof URLSearchParams) {
    return serializeBody(body.toString());
  }

  if (body instanceof Blob) {
    return serializeBody(await body.text());
  }

  if (body instanceof FormData) {
    const json: Record<string, string[]> = {};
    body.forEach((value, key) => {
      const nextValue = typeof value === "string" ? value : value.name;
      json[key] = [...(json[key] ?? []), nextValue];
    });
    return {
      text: JSON.stringify(json),
      json
    };
  }

  if (body instanceof ArrayBuffer) {
    return serializeBody(new TextDecoder().decode(new Uint8Array(body)));
  }

  if (ArrayBuffer.isView(body)) {
    return serializeBody(new TextDecoder().decode(body));
  }

  return undefined;
}

async function readFetchRequestBody(input: RequestInfo | URL, init?: RequestInit): Promise<CapturedBody | undefined> {
  if (init?.body) {
    return serializeBody(init.body);
  }

  if (input instanceof Request) {
    try {
      return serializeBody(await input.clone().text());
    } catch {
      return undefined;
    }
  }

  return undefined;
}

function patchFetch(): void {
  const nativeFetch = window.fetch;
  window.fetch = async function patchedFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
    const request = input instanceof Request ? input : new Request(input, init);
    const url = request.url;
    if (!shouldCapture(url)) {
      return nativeFetch.apply(this, [input, init] as [RequestInfo | URL, RequestInit | undefined]);
    }

    const response = await nativeFetch.apply(this, [input, init] as [RequestInfo | URL, RequestInit | undefined]);
    const requestBody = await readFetchRequestBody(input, init);

    try {
      const clone = response.clone();
      const text = truncate(await clone.text()) ?? "";
      postCapture({
        providerHint: providerHintFromUrl(url),
        pageUrl: location.href,
        requestId: `${Date.now()}-${Math.random().toString(36).slice(2)}`,
        method: request.method,
        url,
        capturedAt: new Date().toISOString(),
        requestBody,
        response: {
          status: response.status,
          ok: response.ok,
          contentType: clone.headers.get("content-type") ?? undefined,
          text,
          json: safeJsonParse(text)
        }
      });
    } catch {
      // Streaming and opaque responses can fail to clone or decode.
    }

    return response;
  };
}

function patchXHR(): void {
  const nativeOpen = XMLHttpRequest.prototype.open;
  const nativeSend = XMLHttpRequest.prototype.send;

  XMLHttpRequest.prototype.open = function patchedOpen(
    this: TrackedXHR,
    method: string,
    url: string | URL,
    async?: boolean,
    username?: string | null,
    password?: string | null
  ): void {
    this.__tsmcMethod = method;
    this.__tsmcUrl = String(url);
    return nativeOpen.call(this, method, url, async ?? true, username ?? null, password ?? null);
  };

  XMLHttpRequest.prototype.send = function patchedSend(this: TrackedXHR, body?: Document | XMLHttpRequestBodyInit | null): void {
    const url = this.__tsmcUrl;
    const method = this.__tsmcMethod ?? "GET";
    const requestBodyPromise = serializeBody(body);

    if (url && shouldCapture(url)) {
      this.addEventListener(
        "loadend",
        () => {
          void requestBodyPromise.then((requestBody) => {
            const text =
              this.responseType === "" || this.responseType === "text"
                ? truncate(this.responseText) ?? ""
                : "";
            postCapture({
              providerHint: providerHintFromUrl(url),
              pageUrl: location.href,
              requestId: `${Date.now()}-${Math.random().toString(36).slice(2)}`,
              method,
              url,
              capturedAt: new Date().toISOString(),
              requestBody,
              response: {
                status: this.status,
                ok: this.status >= 200 && this.status < 300,
                contentType: this.getResponseHeader("content-type") ?? undefined,
                text,
                json: safeJsonParse(text)
              }
            });
          });
        },
        { once: true }
      );
    }

    return nativeSend.call(this, body);
  };
}

const windowFlags = window as unknown as Record<string, unknown>;

if (!windowFlags[OBSERVER_FLAG]) {
  windowFlags[OBSERVER_FLAG] = true;
  patchFetch();
  patchXHR();
}


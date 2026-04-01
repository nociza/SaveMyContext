import type { IProviderScraper } from "./provider";
import { ChatGPTScraper } from "./chatgpt";
import { GeminiScraper } from "./gemini";
import { GrokScraper } from "./grok";

export const providerRegistry: IProviderScraper[] = [
  new ChatGPTScraper(),
  new GeminiScraper(),
  new GrokScraper()
];


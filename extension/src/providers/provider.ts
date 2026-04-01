import type { CapturedNetworkEvent, NormalizedSessionSnapshot, ProviderName } from "../shared/types";

export interface IProviderScraper {
  readonly provider: ProviderName;
  matches(event: CapturedNetworkEvent): boolean;
  parse(event: CapturedNetworkEvent): NormalizedSessionSnapshot | null;
}


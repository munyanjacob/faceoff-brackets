import { transport } from "./transport";
import type { DiscoverResponse } from "./types";

/** Public bracket discovery. */
export const discoveryService = {
  listPublic: (): Promise<DiscoverResponse> => transport.listPublic(),
};

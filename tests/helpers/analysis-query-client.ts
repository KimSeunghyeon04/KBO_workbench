import { QueryClient } from "@tanstack/react-query";
import type { PlayerDirectoryEntry } from "@kbo/contracts";

/** Existing feature tests use a fixed imported-season catalog; network refresh has its own tests. */
export function createAnalysisQueryClient(directory: PlayerDirectoryEntry[] = []) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  client.setQueryData(["analysis-seasons"], {
    sourceHash: "a".repeat(64),
    seasons: [2025, 2024, 2023, 2022, 2021, 2020],
    preparation: [],
  });
  client.setQueryData(["analysis-player-directory"], directory);
  return client;
}

import type { Pool } from "pg";
import type { StagingGameDocumentV2 } from "@kbo/contracts";
import { extractNaverPlayerHeights } from "@kbo/collection";
import { PlayerHeightRepository } from "@kbo/persistence";

export function batterHeightDataset(document: StagingGameDocumentV2, heightCm = 168) {
  return extractNaverPlayerHeights({
    gameId: document.metadata.gameId,
    season: document.metadata.season,
    sourceBundleHash: document.source.sourceBundleHash,
    payloads: {
      lineup: {
        result: {
          previewData: {
            awayTeamLineUp: {
              fullLineUp: document.rosters.away.players.map((p) => ({
                playerCode: p.playerId,
                height: String(heightCm) + ".0",
              })),
            },
          },
        },
      },
    },
  });
}
/** Actual Naver parser and relational height writer, only in isolated test databases. */
export async function seedBatterHeights(
  pool: Pool,
  document: StagingGameDocumentV2,
  heightCm = 168,
) {
  return new PlayerHeightRepository(pool).importDataset(batterHeightDataset(document, heightCm));
}

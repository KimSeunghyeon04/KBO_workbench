import type { StagingGameDocumentV2 } from "@kbo/contracts";

export function workspaceDisplaySummary(document: StagingGameDocumentV2) {
  return {
    gameDate: document.metadata.gameDate,
    teams: {
      away: { teamId: document.teams.away.teamId, name: document.teams.away.name },
      home: { teamId: document.teams.home.teamId, name: document.teams.home.name },
    },
  };
}

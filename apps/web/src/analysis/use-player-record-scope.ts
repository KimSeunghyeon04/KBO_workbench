import type { PlayerGameRecordsQuery } from "@kbo/contracts";
import { findDirectoryPlayer, usePlayerDirectory } from "./player-directory";
import {
  playerRecordId,
  playerRoleForRecord,
  selectedPlayerRole,
} from "./player-analysis-navigation";
import { useAnalysisScope } from "./use-analysis-scope";

export function usePlayerRecordScope() {
  const analysis = useAnalysisScope();
  const { params, season, scope } = analysis;
  const directory = usePlayerDirectory();
  const requestedRole = selectedPlayerRole(params);
  const identity = params.get("player");
  const sourceId = params.get(requestedRole);
  const player = findDirectoryPlayer(directory.data, identity, sourceId);
  const record = player?.seasons.find((entry) => entry.season === season);
  const role = playerRoleForRecord(record, requestedRole);
  const id = identity ?? player?.identity ?? sourceId;
  const query: PlayerGameRecordsQuery | null =
    id === null
      ? null
      : {
          season,
          ...scope.options,
          player: id,
          role,
          ...(identity === null && player === undefined ? { source: "naver" } : {}),
        };
  return {
    ...analysis,
    identity: player?.identity ?? identity,
    role,
    rawId: playerRecordId(record, role) ?? sourceId,
    loading: Boolean((identity || sourceId) && directory.isPending),
    query,
  };
}

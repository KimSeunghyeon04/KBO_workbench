import { compareCanonicalStrings, type Side } from "@kbo/contracts";

import type { SourceFinding } from "../types.js";
import type { RosterDraft } from "./roster-mapper.js";
import {
  isRecord,
  normalizedName,
  optionalText,
  record,
  type JsonRecord,
} from "./source-values.js";

interface RecordIdentity {
  readonly playerIds: readonly string[];
  readonly names: readonly string[];
  readonly side: Side;
  readonly pitcher: boolean;
  readonly path: string;
  readonly rowIndex: number;
}

/** Boxscore participation supplies identity, never starting order or inferred relay events. */
export function supplementNaverRosters(
  rosters: Readonly<Record<Side, RosterDraft>>,
  recordPayload: JsonRecord,
): { readonly rosters: Readonly<Record<Side, RosterDraft>>; readonly findings: SourceFinding[] } {
  const findings: SourceFinding[] = [];
  const identities = recordIdentities(recordPayload);
  const byId = new Map<string, RecordIdentity[]>();
  for (const identity of identities) {
    for (const playerId of identity.playerIds) {
      const group = byId.get(playerId) ?? [];
      group.push(identity);
      byId.set(playerId, group);
    }
  }
  const supplemented = {
    away: { ...rosters.away, players: [...rosters.away.players] },
    home: { ...rosters.home, players: [...rosters.home.players] },
  };
  for (const [playerId, evidence] of [...byId].sort(([left], [right]) =>
    compareCanonicalStrings(left, right),
  )) {
    const first = evidence[0];
    if (first === undefined) continue;
    const existing = (["away", "home"] as const).flatMap((side) =>
      rosters[side].players.filter((player) => player.playerId === playerId).map(() => ({ side })),
    );
    const sides = new Set([...evidence, ...existing].map((item) => item.side));
    if (sides.size !== 1 || evidence.some((item) => item.playerIds.length !== 1)) {
      for (const item of evidence) {
        findings.push(
          identityFinding(
            item,
            "identity_conflict",
            "blocking",
            `선수 ${playerId}의 ID·이름·팀 근거가 충돌해 로스터를 보완하지 않았습니다.`,
          ),
        );
      }
      continue;
    }
    // Existing preview identity stays authoritative; boxscore display names may be shortened.
    if (existing.length > 0) continue;
    const names = new Set(evidence.flatMap((item) => item.names));
    if (names.size > 1) {
      for (const item of evidence) {
        findings.push(
          identityFinding(
            item,
            "identity_conflict",
            "blocking",
            `선수 ${playerId}의 이름 근거가 충돌해 로스터를 보완하지 않았습니다.`,
          ),
        );
      }
      continue;
    }
    const name = first.names[0];
    if (name === undefined || evidence.some((item) => item.names.length !== 1)) {
      for (const item of evidence) {
        findings.push(
          identityFinding(
            item,
            "identity_missing",
            "blocking",
            `선수 ${playerId}의 이름을 확인할 수 없어 로스터를 보완하지 않았습니다.`,
          ),
        );
      }
      continue;
    }
    supplemented[first.side].players.push({
      playerId,
      name,
      starter: false,
      positions: evidence.some((item) => item.pitcher) ? ["투수"] : [],
    });
    for (const item of evidence) {
      findings.push(
        identityFinding(
          item,
          "supplemented_from_record",
          "warning",
          `박스스코어의 ${item.side} 선수 ${playerId} (${name})를 누락 로스터에 추가했습니다. 선발·타순은 추정하지 않았습니다.`,
        ),
      );
    }
  }
  return { rosters: supplemented, findings };
}

function recordIdentities(payload: JsonRecord): RecordIdentity[] {
  const identities: RecordIdentity[] = [];
  for (const [pitcher, aliases] of [
    [false, ["battersBoxscore", "batter", "batters"]],
    [true, ["pitchersBoxscore", "pitcher", "pitchers"]],
  ] as const) {
    const rootKey = aliases.find((key) => payload[key] !== undefined);
    if (rootKey === undefined) continue;
    const root = record(payload[rootKey]);
    for (const side of ["away", "home"] as const) {
      const rows = root[side];
      if (!Array.isArray(rows)) continue;
      for (const [rowIndex, row] of rows.entries()) {
        if (!isRecord(row)) continue;
        identities.push({
          playerIds: distinctText(row, ["playerCode", "pcode", "playerId"]),
          names: [...new Set(distinctText(row, ["playerName", "name"]).map(normalizedName))],
          side,
          pitcher,
          path: `${rootKey}.${side}[${String(rowIndex)}]`,
          rowIndex,
        });
      }
    }
  }
  return identities;
}

function distinctText(row: JsonRecord, keys: readonly string[]): string[] {
  return [
    ...new Set(
      keys.flatMap((key) => {
        const text = optionalText(row[key]);
        return text === null ? [] : [text.normalize("NFC")];
      }),
    ),
  ];
}

function identityFinding(
  evidence: RecordIdentity,
  rule: string,
  severity: SourceFinding["severity"],
  message: string,
): SourceFinding {
  return {
    lifecycle: "persistent",
    code: `source.roster.${rule}`,
    severity,
    endpoint: "record",
    rowIndex: evidence.rowIndex,
    message: `${evidence.path}: ${message}`,
  };
}

import type {
  CorrectionCalculatedRecords,
  OfficialBatterRecord,
  OfficialPitcherRecord,
  Side,
  StagingGameDocumentV2,
} from "@kbo/contracts";

export type RecordKind = "batter" | "pitcher";
export type RecordComparisonStatus =
  "match" | "mismatch" | "official_missing" | "calculated_missing" | "not_calculated";

export interface RecordFieldComparison {
  readonly field: string;
  readonly label: string;
  readonly official: number | undefined;
  readonly calculated: number | null | undefined;
  readonly status: RecordComparisonStatus;
}

export interface PlayerRecordComparison {
  readonly recordIdentity: string;
  readonly kind: RecordKind;
  readonly playerId: string;
  readonly side: Side;
  readonly playerName: string;
  readonly teamName: string;
  readonly battingOrder: number | undefined;
  readonly fields: readonly RecordFieldComparison[];
  readonly mismatchCount: number;
}

const batterFields = [
  ["plateAppearances", "타석"],
  ["atBats", "타수"],
  ["runs", "득점"],
  ["hits", "안타"],
  ["doubles", "2루타"],
  ["triples", "3루타"],
  ["homeRuns", "홈런"],
  ["runsBattedIn", "타점"],
  ["walks", "볼넷"],
  ["intentionalWalks", "고의4구"],
  ["hitByPitch", "몸에 맞는 공"],
  ["strikeouts", "삼진"],
  ["sacrificeBunts", "희생번트"],
  ["sacrificeFlies", "희생플라이"],
] as const satisfies readonly (readonly [keyof OfficialBatterRecord, string])[];

const pitcherFields = [
  ["battersFaced", "상대 타자"],
  ["outsRecorded", "아웃"],
  ["hits", "피안타"],
  ["runs", "실점"],
  ["earnedRuns", "자책점"],
  ["walks", "볼넷"],
  ["intentionalWalks", "고의4구"],
  ["hitByPitch", "몸에 맞는 공"],
  ["strikeouts", "삼진"],
  ["pitches", "투구 수"],
  ["strikes", "스트라이크"],
] as const satisfies readonly (readonly [keyof OfficialPitcherRecord, string])[];

export function buildPlayerRecordComparisons(
  document: StagingGameDocumentV2,
  calculatedRecords: CorrectionCalculatedRecords,
): PlayerRecordComparison[] {
  const batters = unionPlayerIds(
    document.officialRecords.batters.map((record) => record.playerId),
    calculatedRecords.batters.map((record) => record.playerId),
  ).map((playerId) => {
    const official = document.officialRecords.batters.find(
      (record) => record.playerId === playerId,
    );
    const calculated = calculatedRecords.batters.find((record) => record.playerId === playerId);
    const side = official?.side ?? calculated?.side;
    if (side === undefined) throw new Error(`타자 기록의 팀을 확인할 수 없습니다: ${playerId}`);
    return comparison(
      document,
      "batter",
      playerId,
      side,
      batterFields.map(([field, label]) =>
        fieldComparison(field, label, official?.[field], calculated?.[field]),
      ),
    );
  });
  const pitchers = unionPlayerIds(
    document.officialRecords.pitchers.map((record) => record.playerId),
    calculatedRecords.pitchers.map((record) => record.playerId),
  ).map((playerId) => {
    const official = document.officialRecords.pitchers.find(
      (record) => record.playerId === playerId,
    );
    const calculated = calculatedRecords.pitchers.find((record) => record.playerId === playerId);
    const side = official?.side ?? calculated?.side;
    if (side === undefined) throw new Error(`투수 기록의 팀을 확인할 수 없습니다: ${playerId}`);
    return comparison(
      document,
      "pitcher",
      playerId,
      side,
      pitcherFields.map(([field, label]) =>
        fieldComparison(field, label, official?.[field], calculated?.[field]),
      ),
    );
  });

  return [...batters, ...pitchers].sort(comparePlayerRecords);
}

export function parseOfficialRecordIdentity(
  recordIdentity: string | undefined,
): { readonly kind: RecordKind; readonly playerId: string } | null {
  if (recordIdentity === undefined) return null;
  for (const kind of ["batter", "pitcher"] as const) {
    const prefix = `${kind}:`;
    if (recordIdentity.startsWith(prefix) && recordIdentity.length > prefix.length)
      return { kind, playerId: recordIdentity.slice(prefix.length) };
  }
  return null;
}

export function recordIdentityLabel(
  document: StagingGameDocumentV2,
  recordIdentity: string | undefined,
): string | null {
  const parsed = parseOfficialRecordIdentity(recordIdentity);
  if (parsed === null) return null;
  const official =
    parsed.kind === "batter"
      ? document.officialRecords.batters.find((record) => record.playerId === parsed.playerId)
      : document.officialRecords.pitchers.find((record) => record.playerId === parsed.playerId);
  const side = official?.side ?? rosterSide(document, parsed.playerId);
  const player =
    side === undefined
      ? undefined
      : document.rosters[side].players.find((item) => item.playerId === parsed.playerId);
  const team = side === undefined ? null : document.teams[side].name;
  const role = parsed.kind === "batter" ? "타자" : "투수";
  return `${role} · ${team === null ? "팀 미확인" : team} ${player?.name ?? "명단 미확인"} (${parsed.playerId})`;
}

export function recordKindLabel(kind: RecordKind): string {
  return kind === "batter" ? "타자" : "투수";
}

export function recordFieldLabel(kind: RecordKind, field: string): string | null {
  const descriptor = (kind === "batter" ? batterFields : pitcherFields).find(
    ([candidate]) => candidate === field,
  );
  return descriptor?.[1] ?? null;
}

function comparison(
  document: StagingGameDocumentV2,
  kind: RecordKind,
  playerId: string,
  side: Side,
  fields: readonly RecordFieldComparison[],
): PlayerRecordComparison {
  const player = document.rosters[side].players.find((item) => item.playerId === playerId);
  return {
    recordIdentity: `${kind}:${playerId}`,
    kind,
    playerId,
    side,
    playerName: player?.name ?? "명단 미확인",
    teamName: document.teams[side].name,
    battingOrder: player?.battingOrder,
    fields,
    mismatchCount: fields.filter((field) => field.status === "mismatch").length,
  };
}

function fieldComparison(
  field: string,
  label: string,
  official: number | undefined,
  calculated: number | null | undefined,
): RecordFieldComparison {
  const status: RecordComparisonStatus =
    official === undefined
      ? "official_missing"
      : calculated === undefined
        ? "calculated_missing"
        : calculated === null
          ? "not_calculated"
          : official === calculated
            ? "match"
            : "mismatch";
  return { field, label, official, calculated, status };
}

function unionPlayerIds(first: readonly string[], second: readonly string[]): string[] {
  return [...new Set([...first, ...second])];
}

function rosterSide(document: StagingGameDocumentV2, playerId: string): Side | undefined {
  if (document.rosters.away.players.some((player) => player.playerId === playerId)) return "away";
  if (document.rosters.home.players.some((player) => player.playerId === playerId)) return "home";
  return undefined;
}

function comparePlayerRecords(left: PlayerRecordComparison, right: PlayerRecordComparison): number {
  return (
    sideRank(left.side) - sideRank(right.side) ||
    (left.battingOrder ?? Number.MAX_SAFE_INTEGER) -
      (right.battingOrder ?? Number.MAX_SAFE_INTEGER) ||
    left.playerName.localeCompare(right.playerName, "ko-KR") ||
    left.playerId.localeCompare(right.playerId)
  );
}

function sideRank(side: Side): number {
  return side === "away" ? 0 : 1;
}

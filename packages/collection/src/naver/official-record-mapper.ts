import type { OfficialBatterRecord, OfficialPitcherRecord, Side } from "@kbo/contracts";

import { NaverSourceFormatError } from "../errors.js";
import type { SourceFinding } from "../types.js";
import { enrichNaverOfficialExtraBaseHits } from "./official-extra-base-hits.js";
import {
  first,
  integer,
  optionalRecords,
  optionalText,
  record,
  requireText,
  type JsonRecord,
} from "./source-values.js";

export function mapNaverOfficialRecords(recordValue: JsonRecord): {
  readonly batters: readonly OfficialBatterRecord[];
  readonly pitchers: readonly OfficialPitcherRecord[];
  readonly findings: readonly SourceFinding[];
} {
  const batterKey = ["battersBoxscore", "batter", "batters"].find(
    (key) => recordValue[key] !== undefined,
  );
  const batterRoot = record(batterKey === undefined ? undefined : recordValue[batterKey]);
  const pitcherRoot = record(first(recordValue, ["pitchersBoxscore", "pitcher", "pitchers"]));
  const mappedBatters = (["away", "home"] as const).flatMap((side) =>
    optionalRecords(batterRoot[side]).map((row, index) =>
      enrichNaverOfficialExtraBaseHits(
        row,
        mapBatterRecord(row, side),
        `${batterKey ?? "battersBoxscore"}.${side}`,
        index,
      ),
    ),
  );
  const pitcherRows = (["away", "home"] as const).flatMap((side) =>
    optionalRecords(pitcherRoot[side]).map((row) => ({ row, side })),
  );
  const alternatePitchCountShape =
    pitcherRows.length > 0 &&
    pitcherRows.some(({ row }) => /^\s*\d+\.[12]\s*$/.test(optionalText(row.inn) ?? "")) &&
    pitcherRows.every(({ row }) => {
      const bf = integer(row.bf);
      const pa = integer(row.pa);
      return bf !== null && pa !== null && bf === pa;
    });
  return {
    batters: mappedBatters.map((mapped) => mapped.official),
    findings: mappedBatters.flatMap((mapped) => mapped.findings),
    pitchers: pitcherRows.map(({ row, side }) =>
      mapPitcherRecord(row, side, alternatePitchCountShape),
    ),
  };
}

function mapBatterRecord(row: JsonRecord, side: Side): OfficialBatterRecord {
  return {
    playerId: requireText(first(row, ["playerCode", "pcode", "playerId"]), "공식 타자 ID"),
    side,
    ...(optionalNonNegative(first(row, ["pa", "plateAppearances"])) === null
      ? {}
      : { plateAppearances: optionalNonNegative(first(row, ["pa", "plateAppearances"])) ?? 0 }),
    atBats: nonNegative(first(row, ["ab", "atBats"])),
    runs: nonNegative(first(row, ["run", "runs"])),
    hits: nonNegative(first(row, ["hit", "hits"])),
    ...optionalStat(row, ["h2", "double", "doubles"], "doubles"),
    ...optionalStat(row, ["h3", "triple", "triples"], "triples"),
    homeRuns: nonNegative(first(row, ["hr", "homeRuns"])),
    runsBattedIn: nonNegative(first(row, ["rbi", "runsBattedIn"])),
    walks: nonNegative(first(row, ["bb", "walks"])),
    ...optionalStat(row, ["ibb", "intentionalWalks"], "intentionalWalks"),
    ...optionalStat(row, ["hp", "hbp", "hitByPitch"], "hitByPitch"),
    strikeouts: nonNegative(first(row, ["kk", "so", "strikeouts"])),
    ...optionalStat(row, ["sh", "sacrificeBunts"], "sacrificeBunts"),
    ...optionalStat(row, ["sf", "sacrificeFlies"], "sacrificeFlies"),
  };
}

function mapPitcherRecord(
  row: JsonRecord,
  side: Side,
  alternatePitchCountShape: boolean,
): OfficialPitcherRecord {
  const walks = nonNegative(first(row, ["bb", "walks"]));
  const explicitHitByPitch = optionalNonNegative(first(row, ["hp", "hbp", "hitByPitch"]));
  const combinedFreePasses = optionalNonNegative(row.bbhp);
  const pitches = alternatePitchCountShape
    ? optionalNonNegative(row.pitches)
    : optionalNonNegative(first(row, ["pitches", "ballCount", "bf"]));
  return {
    playerId: requireText(first(row, ["pcode", "playerCode", "playerId"]), "공식 투수 ID"),
    side,
    battersFaced: nonNegative(first(row, ["pa", "battersFaced"])),
    outsRecorded: inningsToOuts(first(row, ["inn", "innings"])),
    hits: nonNegative(first(row, ["hit", "hits"])),
    runs: nonNegative(first(row, ["r", "run", "runs"])),
    earnedRuns: nonNegative(first(row, ["er", "earnedRuns"])),
    walks,
    ...optionalStat(row, ["ibb", "intentionalWalks"], "intentionalWalks"),
    hitByPitch:
      explicitHitByPitch ??
      (combinedFreePasses === null ? 0 : Math.max(0, combinedFreePasses - walks)),
    strikeouts: nonNegative(first(row, ["kk", "so", "strikeouts"])),
    ...(pitches === null ? {} : { pitches }),
    ...optionalStat(row, ["strikeCount", "strikes"], "strikes"),
  };
}

function optionalStat<Key extends string>(
  row: JsonRecord,
  sourceKeys: readonly string[],
  targetKey: Key,
): Partial<Record<Key, number>> {
  const value = optionalNonNegative(first(row, sourceKeys));
  return value === null ? {} : ({ [targetKey]: value } as Partial<Record<Key, number>>);
}

function nonNegative(value: unknown): number {
  const parsed = integer(value);
  if (parsed === null) return 0;
  if (parsed < 0) throw new NaverSourceFormatError("음수 기록값은 허용하지 않습니다.");
  return parsed;
}

function optionalNonNegative(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  const parsed = integer(value);
  if (parsed === null) throw new NaverSourceFormatError("기록값은 정수여야 합니다.");
  if (parsed < 0) throw new NaverSourceFormatError("음수 기록값은 허용하지 않습니다.");
  return parsed;
}

function inningsToOuts(raw: unknown): number {
  const value = optionalText(raw) ?? "0";
  const match = /^(\d+)(?:\s*([⅓⅔])|\.([012])|\s+([12])\/3)?$/.exec(value);
  if (match?.[1] === undefined) {
    throw new NaverSourceFormatError(`투수 이닝 기록이 올바르지 않습니다: ${value}`);
  }
  const fractionalOuts =
    match[2] === "⅓" ? 1 : match[2] === "⅔" ? 2 : Number(match[3] ?? match[4] ?? "0");
  return Number(match[1]) * 3 + fractionalOuts;
}

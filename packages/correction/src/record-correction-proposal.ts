import {
  recordCorrectionSupportKind,
  parseStagingGameDocumentV2,
  type AtomicCorrectionCommand,
  type CorrectionBatch,
  type CorrectionPreview,
  type OfficialBatterRecord,
  type OfficialPitcherRecord,
  type PlateResult,
  type RecordCorrectionNotice,
  type RecordCorrectionProposalChange,
  type StagingGameDocumentV2,
} from "@kbo/contracts";
import { compileStagingGameDocumentV2, type ReplayResult } from "@kbo/game-core";

import { applyCompiledCorrectionCommand } from "./commands.js";

export interface RecordCorrectionProposalBinding {
  readonly eventId: string;
  readonly batterPlayerId: string;
  readonly pitcherPlayerId: string;
  readonly participantPlayerIds: Readonly<Record<string, string>>;
}

export interface BuiltRecordCorrectionProposal {
  readonly eligible: boolean;
  readonly reasons: readonly string[];
  readonly changes: readonly RecordCorrectionProposalChange[];
  readonly batch: CorrectionBatch | null;
  readonly preview: CorrectionPreview | null;
}

type RecordCorrectionStatCode = RecordCorrectionNotice["statChanges"][number]["statCode"];

interface OfficialFieldDescriptor<Field extends PropertyKey> {
  readonly field: Field;
  readonly omittedValue: number | null;
}

type BatterFieldDescriptor = OfficialFieldDescriptor<keyof OfficialBatterRecord>;
type PitcherFieldDescriptor = OfficialFieldDescriptor<keyof OfficialPitcherRecord>;

const BATTER_FIELDS: Readonly<Partial<Record<RecordCorrectionStatCode, BatterFieldDescriptor>>> = {
  plate_appearances: field("plateAppearances"),
  at_bats: field("atBats"),
  runs: field("runs"),
  hits: field("hits"),
  doubles: zeroWhenOmitted("doubles"),
  triples: zeroWhenOmitted("triples"),
  home_runs: field("homeRuns"),
  runs_batted_in: field("runsBattedIn"),
  walks: field("walks"),
  intentional_walks: zeroWhenOmitted("intentionalWalks"),
  hit_by_pitch: zeroWhenOmitted("hitByPitch"),
  strikeouts: field("strikeouts"),
  sacrifice_bunts: zeroWhenOmitted("sacrificeBunts"),
  sacrifice_flies: zeroWhenOmitted("sacrificeFlies"),
};

const PITCHER_FIELDS: Readonly<Partial<Record<RecordCorrectionStatCode, PitcherFieldDescriptor>>> =
  {
    batters_faced: field("battersFaced"),
    outs_pitched: field("outsRecorded"),
    hits_allowed: field("hits"),
    runs_allowed: field("runs"),
    earned_runs: field("earnedRuns"),
    walks_allowed: field("walks"),
    intentional_walks_allowed: zeroWhenOmitted("intentionalWalks"),
    hit_batters: field("hitByPitch"),
    strikeouts_pitched: field("strikeouts"),
    pitches: field("pitches"),
    strikes: field("strikes"),
  };

export function buildRecordCorrectionBatchProposal(
  document: StagingGameDocumentV2,
  notice: RecordCorrectionNotice,
  binding: RecordCorrectionProposalBinding,
): BuiltRecordCorrectionProposal {
  return createRecordCorrectionProposalBuilder(document)(notice, binding);
}

export function createRecordCorrectionProposalBuilder(input: StagingGameDocumentV2) {
  // Own a strict decoded snapshot; callers cannot pair a different ledger with this compile.
  const document = parseStagingGameDocumentV2(structuredClone(input));
  const replay = compileStagingGameDocumentV2(document);
  return (
    notice: RecordCorrectionNotice,
    binding: RecordCorrectionProposalBinding,
  ): BuiltRecordCorrectionProposal =>
    structuredClone(buildProposal(document, replay, notice, binding));
}

function buildProposal(
  document: StagingGameDocumentV2,
  replay: ReplayResult,
  notice: RecordCorrectionNotice,
  binding: RecordCorrectionProposalBinding,
): BuiltRecordCorrectionProposal {
  const reasons: string[] = [];
  const changes: RecordCorrectionProposalChange[] = [];
  const commands: AtomicCorrectionCommand[] = [];
  const event = document.events.find((item) => item.identity.eventId === binding.eventId);
  if (event?.kind !== "plate_result") {
    return blocked("선택한 이벤트가 타석 결과가 아닙니다.", changes);
  }
  if (
    event.payload.batterId !== binding.batterPlayerId ||
    event.payload.pitcherId !== binding.pitcherPlayerId
  ) {
    return blocked("선택한 이벤트의 타자 또는 투수가 매칭 결과와 다릅니다.", changes);
  }

  const targetResult = targetPlateResult(document, notice, binding, event.payload.result, reasons);
  if (targetResult !== null) {
    const currentDecision = decisionForResult(event.payload.result);
    const targetDecision = decisionForResult(targetResult.result);
    if (currentDecision !== notice.decisionBefore && currentDecision !== notice.decisionAfter)
      reasons.push("현재 플레이 판정이 KBO 정정 전·후 어느 값과도 일치하지 않습니다.");
    else if (targetDecision === currentDecision && targetResult.result === event.payload.result)
      changes.push(
        change(
          "event",
          binding.batterPlayerId,
          "result",
          event.payload.result,
          targetResult.result,
          "already_applied",
        ),
      );
    else if (
      effectiveDestination(event.payload.result, event.payload.batterDestination) !==
      targetResult.destination
    )
      reasons.push("정정 후 타자 도착 베이스가 달라져 물리적 주자 상태를 자동 변경할 수 없습니다.");
    else {
      let creditedRbi = event.payload.creditedRbi;
      const rbiChange = notice.statChanges.find(
        (stat) =>
          stat.statCode === "runs_batted_in" &&
          participantPlayerId(binding, stat.participantIndex) === binding.batterPlayerId,
      );
      if (rbiChange !== undefined && rbiChange.beforeValue !== rbiChange.afterValue) {
        const currentRbi = event.payload.creditedRbi ?? 0;
        const nextRbi = currentRbi + rbiChange.afterValue - rbiChange.beforeValue;
        if (nextRbi < 0 || nextRbi > 4) reasons.push("이벤트 RBI 변경값이 허용 범위를 벗어납니다.");
        else creditedRbi = nextRbi;
      }
      const replacement = {
        ...event,
        payload: {
          ...event.payload,
          result: targetResult.result,
          ...(creditedRbi === undefined ? {} : { creditedRbi }),
          ...(targetResult.result === "sacrifice_bunt" ? { isBunt: true as const } : {}),
        },
      };
      commands.push({
        commandId: commandId(notice.noticeId, "event"),
        kind: "replace_event",
        eventId: binding.eventId,
        event: replacement,
      });
      changes.push(
        change(
          "event",
          binding.batterPlayerId,
          "result",
          event.payload.result,
          targetResult.result,
          "change",
        ),
      );
      if (creditedRbi !== event.payload.creditedRbi)
        changes.push(
          change(
            "event",
            binding.batterPlayerId,
            "creditedRbi",
            event.payload.creditedRbi ?? 0,
            creditedRbi ?? 0,
            "change",
          ),
        );
    }
  }

  const batterRecords = new Map<string, OfficialBatterRecord>();
  const pitcherRecords = new Map<string, OfficialPitcherRecord>();
  for (const stat of notice.statChanges) {
    const playerId = participantPlayerId(binding, stat.participantIndex);
    const supportKind = effectiveSupportKind(stat);
    if (supportKind === "evidence_only" || supportKind === "unknown") {
      changes.push(
        change(
          "evidence_only",
          playerId,
          stat.rawStatName,
          stat.beforeValue,
          stat.afterValue,
          "evidence_only",
        ),
      );
      continue;
    }
    if (supportKind === "derived") {
      const batterId = playerId ?? binding.batterPlayerId;
      const line = replay.batterLines.find((item) => item.playerId === batterId);
      const current =
        line === undefined ? null : line.hits + line.doubles + 2 * line.triples + 3 * line.homeRuns;
      const state =
        current === stat.afterValue
          ? "verified"
          : current === stat.beforeValue
            ? "change"
            : "conflict";
      changes.push(change("derived", batterId, stat.rawStatName, current, stat.afterValue, state));
      if (state === "conflict")
        reasons.push(`파생 검증값 ${stat.rawStatName}이 정정 전·후와 다릅니다.`);
      continue;
    }
    if (playerId === null) {
      changes.push(
        change(
          "evidence_only",
          null,
          stat.rawStatName,
          stat.beforeValue,
          stat.afterValue,
          "conflict",
        ),
      );
      reasons.push(`${stat.rawStatName}의 선수를 하나로 식별할 수 없습니다.`);
      continue;
    }
    if (stat.scope === "batter") {
      const original = document.officialRecords.batters.find((item) => item.playerId === playerId);
      const descriptor = BATTER_FIELDS[stat.statCode];
      if (original === undefined || descriptor === undefined) {
        reasons.push(`${stat.rawStatName} 타자 공식 기록을 현재 원장에서 찾을 수 없습니다.`);
        changes.push(
          change("official_batter", playerId, stat.rawStatName, null, stat.afterValue, "conflict"),
        );
        continue;
      }
      const current = batterRecords.get(playerId) ?? original;
      const value = numericField(current, descriptor);
      if (value === stat.afterValue) {
        changes.push(
          change(
            "official_batter",
            playerId,
            descriptor.field,
            value,
            stat.afterValue,
            "already_applied",
          ),
        );
      } else if (
        value !== stat.beforeValue &&
        (current[descriptor.field] !== undefined || descriptor.omittedValue === null)
      ) {
        reasons.push(`${stat.rawStatName} 타자 공식 기록이 정정 전·후 어느 값과도 다릅니다.`);
        changes.push(
          change("official_batter", playerId, descriptor.field, value, stat.afterValue, "conflict"),
        );
      } else {
        batterRecords.set(playerId, { ...current, [descriptor.field]: stat.afterValue });
        changes.push(
          change(
            "official_batter",
            playerId,
            descriptor.field,
            current[descriptor.field] === undefined && value !== stat.beforeValue ? null : value,
            stat.afterValue,
            "change",
          ),
        );
      }
    } else if (stat.scope === "pitcher") {
      const original = document.officialRecords.pitchers.find((item) => item.playerId === playerId);
      const descriptor = PITCHER_FIELDS[stat.statCode];
      if (original === undefined || descriptor === undefined) {
        reasons.push(`${stat.rawStatName} 투수 공식 기록을 현재 원장에서 찾을 수 없습니다.`);
        changes.push(
          change("official_pitcher", playerId, stat.rawStatName, null, stat.afterValue, "conflict"),
        );
        continue;
      }
      const current = pitcherRecords.get(playerId) ?? original;
      const value = numericField(current, descriptor);
      if (value === stat.afterValue) {
        changes.push(
          change(
            "official_pitcher",
            playerId,
            descriptor.field,
            value,
            stat.afterValue,
            "already_applied",
          ),
        );
      } else if (
        value !== stat.beforeValue &&
        (current[descriptor.field] !== undefined || descriptor.omittedValue === null)
      ) {
        reasons.push(`${stat.rawStatName} 투수 공식 기록이 정정 전·후 어느 값과도 다릅니다.`);
        changes.push(
          change(
            "official_pitcher",
            playerId,
            descriptor.field,
            value,
            stat.afterValue,
            "conflict",
          ),
        );
      } else {
        pitcherRecords.set(playerId, { ...current, [descriptor.field]: stat.afterValue });
        changes.push(
          change(
            "official_pitcher",
            playerId,
            descriptor.field,
            current[descriptor.field] === undefined && value !== stat.beforeValue ? null : value,
            stat.afterValue,
            "change",
          ),
        );
      }
    }
  }
  for (const [playerId, record] of batterRecords)
    commands.push({
      commandId: commandId(notice.noticeId, `batter:${playerId}`),
      kind: "update_official_record",
      recordType: "batter",
      playerId,
      record,
    });
  for (const [playerId, record] of pitcherRecords)
    commands.push({
      commandId: commandId(notice.noticeId, `pitcher:${playerId}`),
      kind: "update_official_record",
      recordType: "pitcher",
      playerId,
      record,
    });

  if (commands.length === 0) {
    return {
      eligible: false,
      reasons,
      changes,
      batch: null,
      preview: null,
    };
  }
  const batch: CorrectionBatch = {
    commandId: commandId(notice.noticeId, "batch"),
    kind: "correction_batch",
    commands,
  };
  try {
    const result = applyCompiledCorrectionCommand(document, replay, batch);
    const beforeBlocking = new Set(
      replay.findings.filter((finding) => finding.severity === "blocking").map(findingKey),
    );
    const newBlocking = result.replay.findings
      .filter((finding) => finding.severity === "blocking")
      .filter((finding) => !beforeBlocking.has(findingKey(finding)));
    if (newBlocking.length > 0)
      reasons.push(`제안 적용 시 새 blocking finding ${String(newBlocking.length)}건이 생깁니다.`);
    verifyAfterState(result.document, result.replay, notice, binding, reasons);
    return {
      eligible: reasons.length === 0,
      reasons,
      changes,
      batch,
      preview: result.preview,
    };
  } catch (error: unknown) {
    reasons.push(error instanceof Error ? error.message : "정정 batch를 컴파일할 수 없습니다.");
    return { eligible: false, reasons, changes, batch, preview: null };
  }
}

function verifyAfterState(
  document: StagingGameDocumentV2,
  replay: ReturnType<typeof compileStagingGameDocumentV2>,
  notice: RecordCorrectionNotice,
  binding: RecordCorrectionProposalBinding,
  reasons: string[],
): void {
  const event = document.events.find((item) => item.identity.eventId === binding.eventId);
  if (
    event?.kind !== "plate_result" ||
    decisionForResult(event.payload.result) !== notice.decisionAfter
  )
    reasons.push("제안 적용 후 플레이가 KBO 정정 후 판정과 일치하지 않습니다.");
  for (const stat of notice.statChanges) {
    const playerId = participantPlayerId(binding, stat.participantIndex);
    const supportKind = effectiveSupportKind(stat);
    if (supportKind === "evidence_only" || supportKind === "unknown") continue;
    if (supportKind === "derived") {
      const batterId = playerId ?? binding.batterPlayerId;
      const line = replay.batterLines.find((item) => item.playerId === batterId);
      const totalBases =
        line === undefined ? null : line.hits + line.doubles + 2 * line.triples + 3 * line.homeRuns;
      if (totalBases !== stat.afterValue)
        reasons.push(`제안 적용 후 ${stat.rawStatName} 파생값이 KBO 정정 후 값과 다릅니다.`);
      continue;
    }
    if (playerId === null) continue;
    if (stat.scope === "batter") {
      const descriptor = BATTER_FIELDS[stat.statCode];
      const record = document.officialRecords.batters.find((item) => item.playerId === playerId);
      if (
        descriptor !== undefined &&
        record !== undefined &&
        numericField(record, descriptor) !== stat.afterValue
      )
        reasons.push(`제안 적용 후 ${stat.rawStatName} 공식 기록이 KBO 정정 후 값과 다릅니다.`);
    } else if (stat.scope === "pitcher") {
      const descriptor = PITCHER_FIELDS[stat.statCode];
      const record = document.officialRecords.pitchers.find((item) => item.playerId === playerId);
      if (
        descriptor !== undefined &&
        record !== undefined &&
        numericField(record, descriptor) !== stat.afterValue
      )
        reasons.push(`제안 적용 후 ${stat.rawStatName} 공식 기록이 KBO 정정 후 값과 다릅니다.`);
    }
  }
}

function targetPlateResult(
  document: StagingGameDocumentV2,
  notice: RecordCorrectionNotice,
  binding: RecordCorrectionProposalBinding,
  currentResult: PlateResult,
  reasons: string[],
): { readonly result: PlateResult; readonly destination: number } | null {
  if (notice.decisionAfter === "fielder_choice")
    return { result: "fielder_choice", destination: 1 };
  if (notice.decisionAfter === "error") {
    const sacrifice = notice.statChanges.find(
      (stat) =>
        stat.statCode === "sacrifice_bunts" &&
        stat.afterValue > stat.beforeValue &&
        participantPlayerId(binding, stat.participantIndex) === binding.batterPlayerId,
    );
    return sacrifice === undefined
      ? { result: "reached_on_error", destination: 1 }
      : { result: "sacrifice_bunt", destination: 1 };
  }
  if (notice.decisionAfter === "hit") {
    if (["single", "double", "triple", "home_run"].includes(currentResult))
      return { result: currentResult, destination: effectiveDestination(currentResult) };
    const totalBases = notice.statChanges.find(
      (stat) =>
        stat.statCode === "total_bases" &&
        participantPlayerId(binding, stat.participantIndex) === binding.batterPlayerId,
    );
    const delta = totalBases === undefined ? null : totalBases.afterValue - totalBases.beforeValue;
    const result =
      delta === 1
        ? "single"
        : delta === 2
          ? "double"
          : delta === 3
            ? "triple"
            : delta === 4
              ? "home_run"
              : null;
    if (result === null) {
      reasons.push("안타 종류를 현재 결과 또는 루타 증감으로 하나로 결정할 수 없습니다.");
      return null;
    }
    return { result, destination: effectiveDestination(result) };
  }
  reasons.push("지원하지 않는 KBO 정정 후 판정입니다.");
  return null;
}

function decisionForResult(result: PlateResult): RecordCorrectionNotice["decisionAfter"] {
  if (["single", "double", "triple", "home_run"].includes(result)) return "hit";
  if (result === "reached_on_error" || result === "sacrifice_bunt") return "error";
  if (result === "fielder_choice") return "fielder_choice";
  return "unknown";
}

function effectiveDestination(result: PlateResult, explicit?: number): number {
  if (explicit !== undefined) return explicit;
  if (result === "double") return 2;
  if (result === "triple" || result === "home_run") return result === "triple" ? 3 : 4;
  return 1;
}

function participantPlayerId(
  binding: RecordCorrectionProposalBinding,
  participantIndex: number | null,
): string | null {
  if (participantIndex === null) return null;
  return binding.participantPlayerIds[String(participantIndex)] ?? null;
}

function effectiveSupportKind(
  stat: RecordCorrectionNotice["statChanges"][number],
): ReturnType<typeof recordCorrectionSupportKind> {
  if (stat.supportKind === "unknown" || stat.supportKind === "evidence_only")
    return stat.supportKind;
  return recordCorrectionSupportKind(stat.scope, stat.statCode);
}

function numericField(
  record: OfficialBatterRecord | OfficialPitcherRecord,
  descriptor: OfficialFieldDescriptor<keyof OfficialBatterRecord | keyof OfficialPitcherRecord>,
): number | null {
  const value = record[descriptor.field as keyof typeof record];
  return typeof value === "number" ? value : descriptor.omittedValue;
}

function field<Field extends PropertyKey>(value: Field): OfficialFieldDescriptor<Field> {
  return { field: value, omittedValue: null };
}

function zeroWhenOmitted<Field extends PropertyKey>(value: Field): OfficialFieldDescriptor<Field> {
  return { field: value, omittedValue: 0 };
}

function change(
  kind: RecordCorrectionProposalChange["kind"],
  playerId: string | null,
  field: string,
  beforeValue: string | number | null,
  afterValue: string | number | null,
  state: RecordCorrectionProposalChange["state"],
): RecordCorrectionProposalChange {
  return { kind, playerId, field, beforeValue, afterValue, state };
}

function commandId(noticeId: string, suffix: string): string {
  return `record-correction:${noticeId}:${suffix}`.slice(0, 200);
}

function findingKey(finding: {
  readonly code: string;
  readonly eventId?: string;
  readonly recordIdentity?: string;
}): string {
  return `${finding.code}:${finding.eventId ?? ""}:${finding.recordIdentity ?? ""}`;
}

function blocked(
  reason: string,
  changes: readonly RecordCorrectionProposalChange[],
): BuiltRecordCorrectionProposal {
  return { eligible: false, reasons: [reason], changes, batch: null, preview: null };
}

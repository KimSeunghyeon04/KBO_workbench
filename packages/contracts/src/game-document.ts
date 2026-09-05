import { Value } from "@sinclair/typebox/value";

import { StagingGameDocumentV2Schema } from "./game-document/document.js";
import type { StagingGameDocumentV2 } from "./game-document/document.js";
import { StagingRelayEventSchema } from "./game-document/events.js";
import type { PlateResult, StagingRelayEvent } from "./game-document/events.js";

export {
  EventIdentitySchema,
  ManualEventIdentitySchema,
  SourceEventIdentitySchema,
  type EventIdentity,
} from "./game-document/identity.js";
export {
  AdministrativeEventSchema,
  BatterStartEventSchema,
  BattedBallTypeSchema,
  HalfInningStartEventSchema,
  PitchCallSchema,
  PitchEventSchema,
  PitchMetadataSchema,
  PlateResultEventSchema,
  PlateResultSchema,
  ReviewEventSchema,
  RunnerAdvanceContextSchema,
  RunnerAdvanceEventSchema,
  RunnerAdvanceReasonSchema,
  RunnerOutcomeSchema,
  RunnerOutKindSchema,
  StagingRelayEventKindSchema,
  StagingRelayEventSchema,
  SubstitutionEventSchema,
  SubstitutionRoleSchema,
  UnresolvedEventSchema,
  type AdministrativeEvent,
  type BatterStartEvent,
  type BattedBallType,
  type HalfInningStartEvent,
  type PitchCall,
  type PitchEvent,
  type PitchMetadata,
  type PlateResult,
  type PlateResultEvent,
  type ReviewEvent,
  type RunnerAdvanceContext,
  type RunnerAdvanceEvent,
  type RunnerAdvanceReason,
  type RunnerOutKind,
  type StagingRelayEvent,
  type StagingRelayEventKind,
  type SubstitutionEvent,
  type UnresolvedEvent,
} from "./game-document/events.js";
export {
  HalfSchema,
  ObservedBasesSchema,
  ObservedStateSchema,
  SideSchema,
  type Half,
  type ObservedState,
  type Side,
} from "./game-document/primitives.js";
export {
  OfficialBatterRecordSchema,
  OfficialPitcherRecordSchema,
  RosterPlayerSchema,
  TeamRosterSchema,
  TeamSchema,
  TrackingCandidateSchema,
  TrackingExclusionReasonSchema,
  TrackingResolutionSchema,
  type OfficialBatterRecord,
  type OfficialPitcherRecord,
  type TrackingCandidate,
  type TrackingExclusionReason,
  type TrackingResolution,
} from "./game-document/records.js";
export {
  StagingGameDocumentV2Schema,
  type StagingGameDocumentV2,
} from "./game-document/document.js";

export interface ContractIssue {
  readonly code: string;
  readonly message: string;
  readonly path: string;
}

export class ContractValidationError extends Error {
  public constructor(public readonly issues: readonly ContractIssue[]) {
    super(issues.map((item) => `${item.path}: ${item.message}`).join("\n"));
    this.name = "ContractValidationError";
  }
}

export function parseStagingGameDocumentV2(value: unknown): StagingGameDocumentV2 {
  if (!Value.Check(StagingGameDocumentV2Schema, value)) {
    throw new ContractValidationError(
      [...Value.Errors(StagingGameDocumentV2Schema, value)].map((error) => ({
        code: `schema_${String(error.type)}`,
        message: error.message,
        path: error.path || "$",
      })),
    );
  }
  const decoded = normalizeDateTimes(Value.Decode(StagingGameDocumentV2Schema, value));
  const issues = validateStagingGameDocumentV2Semantics(decoded);
  if (issues.length > 0) throw new ContractValidationError(issues);
  return decoded;
}

export function parseStagingRelayEvent(value: unknown): StagingRelayEvent {
  if (!Value.Check(StagingRelayEventSchema, value)) {
    throw new ContractValidationError(
      [...Value.Errors(StagingRelayEventSchema, value)].map((error) => ({
        code: `schema_${String(error.type)}`,
        message: error.message,
        path: error.path || "$",
      })),
    );
  }
  return Value.Decode(StagingRelayEventSchema, value);
}

export function validateStagingGameDocumentV2Semantics(
  document: StagingGameDocumentV2,
): readonly ContractIssue[] {
  const issues: ContractIssue[] = [];
  const gameDate = new Date(`${document.metadata.gameDate}T00:00:00.000Z`);
  if (
    !Number.isFinite(gameDate.valueOf()) ||
    gameDate.toISOString().slice(0, 10) !== document.metadata.gameDate
  ) {
    issues.push(issue("invalid_game_date", "/metadata/gameDate", "실재하는 경기 날짜가 아닙니다."));
  }
  if (document.teams.away.teamId === document.teams.home.teamId)
    issues.push(issue("teams_not_distinct", "/teams", "원정팀과 홈팀 ID가 같습니다."));
  if (document.rosters.away.teamId !== document.teams.away.teamId)
    issues.push(
      issue("away_roster_team_mismatch", "/rosters/away/teamId", "원정 roster 팀이 다릅니다."),
    );
  if (document.rosters.home.teamId !== document.teams.home.teamId)
    issues.push(
      issue("home_roster_team_mismatch", "/rosters/home/teamId", "홈 roster 팀이 다릅니다."),
    );
  validateUniquePlayers(document, issues);
  validateUniqueOfficialRecords(document, issues);
  const eventIds = new Set<string>();
  for (const [index, event] of document.events.entries()) {
    if (event.sequence !== index)
      issues.push(
        issue(
          "event_sequence_not_canonical",
          `/events/${index}/sequence`,
          "원장 sequence는 배열 순서와 같아야 합니다.",
        ),
      );
    if (eventIds.has(event.identity.eventId))
      issues.push(
        issue(
          "duplicate_event_id",
          `/events/${index}/identity/eventId`,
          "중복 원장 event ID입니다.",
        ),
      );
    eventIds.add(event.identity.eventId);
    if (event.relayText !== undefined && event.relayText !== event.relayText.trim())
      issues.push(
        issue(
          "relay_text_not_trimmed",
          `/events/${index}/relayText`,
          "중계 문구 앞뒤 공백은 저장할 수 없습니다.",
        ),
      );
    if (event.identity.kind === "manual" && event.relayText === undefined)
      issues.push(
        issue(
          "manual_relay_text_missing",
          `/events/${index}/relayText`,
          "수동 원장 행에는 확정한 중계 문구가 필요합니다.",
        ),
      );
    if (event.identity.kind === "manual" && event.observedStateAfter !== undefined)
      issues.push(
        issue(
          "manual_observed_state_forbidden",
          `/events/${index}/observedStateAfter`,
          "제공자 관측 상태는 source 원장 행에만 저장할 수 있습니다.",
        ),
      );
    if (
      event.kind === "plate_result" &&
      !allowsBattedBall(event.payload.result) &&
      (event.payload.battedBallType !== undefined || event.payload.isBunt !== undefined)
    ) {
      issues.push(
        issue(
          "batted_ball_not_allowed",
          `/events/${index}/payload`,
          "비인플레이 결과에는 타구 정보를 저장할 수 없습니다.",
        ),
      );
    }
  }
  const trackingIds = new Set<string>();
  for (const [index, candidate] of document.trackingCandidates.entries()) {
    if (candidate.sequence !== index)
      issues.push(
        issue(
          "tracking_sequence_not_canonical",
          `/trackingCandidates/${index}/sequence`,
          "tracking sequence는 배열 순서와 같아야 합니다.",
        ),
      );
    if (trackingIds.has(candidate.trackingId))
      issues.push(
        issue(
          "duplicate_tracking_id",
          `/trackingCandidates/${index}/trackingId`,
          "중복 tracking ID입니다.",
        ),
      );
    trackingIds.add(candidate.trackingId);
  }
  for (const [index, candidate] of document.trackingCandidates.entries()) {
    if (
      candidate.resolution.kind === "duplicate" &&
      candidate.resolution.canonicalTrackingId === candidate.trackingId
    ) {
      issues.push(
        issue(
          "tracking_duplicate_self_reference",
          `/trackingCandidates/${index}/resolution/canonicalTrackingId`,
          "tracking 후보는 자기 자신을 중복 대표로 참조할 수 없습니다.",
        ),
      );
    }
    if (
      candidate.resolution.kind === "duplicate" &&
      !trackingIds.has(candidate.resolution.canonicalTrackingId)
    ) {
      issues.push(
        issue(
          "tracking_duplicate_target_missing",
          `/trackingCandidates/${index}/resolution/canonicalTrackingId`,
          "tracking 중복 대표 후보가 문서에 없습니다.",
        ),
      );
    }
  }
  return issues;
}

function allowsBattedBall(result: PlateResult): boolean {
  return !["walk", "intentional_walk", "hit_by_pitch", "strikeout", "interference"].includes(
    result,
  );
}

function normalizeDateTimes(document: StagingGameDocumentV2): StagingGameDocumentV2 {
  return {
    ...document,
    source: {
      ...document.source,
      collectedAt: new Date(document.source.collectedAt).toISOString(),
    },
    metadata: {
      ...document.metadata,
      ...(document.metadata.scheduledAt === undefined
        ? {}
        : { scheduledAt: new Date(document.metadata.scheduledAt).toISOString() }),
    },
    trackingCandidates: document.trackingCandidates.map((observation) => ({
      ...observation,
      ...(observation.observedAt === undefined
        ? {}
        : { observedAt: new Date(observation.observedAt).toISOString() }),
    })),
  };
}

function issue(code: string, path: string, message: string): ContractIssue {
  return { code, path, message };
}

function validateUniquePlayers(document: StagingGameDocumentV2, issues: ContractIssue[]): void {
  const seen = new Map<string, string>();
  for (const side of ["away", "home"] as const) {
    for (const [index, player] of document.rosters[side].players.entries()) {
      const previous = seen.get(player.playerId);
      if (previous !== undefined) {
        issues.push(
          issue(
            "duplicate_roster_player_id",
            `/rosters/${side}/players/${index}/playerId`,
            `roster 선수 ID가 중복됩니다. 첫 위치: ${previous}`,
          ),
        );
      } else {
        seen.set(player.playerId, `/rosters/${side}/players/${index}/playerId`);
      }
    }
  }
}

function validateUniqueOfficialRecords(
  document: StagingGameDocumentV2,
  issues: ContractIssue[],
): void {
  for (const recordType of ["batters", "pitchers"] as const) {
    const seen = new Set<string>();
    for (const [index, record] of document.officialRecords[recordType].entries()) {
      if (seen.has(record.playerId)) {
        issues.push(
          issue(
            "duplicate_official_record_player_id",
            `/officialRecords/${recordType}/${index}/playerId`,
            "같은 유형의 공식 기록에 선수 ID가 중복됩니다.",
          ),
        );
      }
      seen.add(record.playerId);
    }
  }
}

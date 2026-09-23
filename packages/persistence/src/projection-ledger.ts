import type { StagingGameDocumentV2 } from "@kbo/contracts";
import { parseStagingGameDocumentV2 } from "@kbo/contracts";
import { PersistenceIntegrityError } from "./errors.js";
import { hydrateEvents } from "./projection-events.js";
import {
  boolean,
  dateText,
  group,
  half,
  number,
  requiredNullableText,
  side,
  stance,
  teamsFromProjection,
  text,
  trackingExclusionReason,
  trackingNumbersFromRow,
} from "./projection-values.js";
import type { ProjectionTables } from "./projection.js";
import type { ProjectionLedgerManifest } from "./revision-types.js";

export function hydrateProjectionLedger(
  manifest: ProjectionLedgerManifest,
  tables: ProjectionTables,
): StagingGameDocumentV2 {
  const teams = teamsFromProjection(tables);
  const positions = group(
    tables.game_roster_positions,
    (row) => `${text(row.side)}:${number(row.roster_index)}`,
  );
  const roster = (teamSide: "away" | "home") => ({
    teamId: teams[teamSide].teamId,
    players: tables.game_roster_snapshots
      .filter((row) => row.side === teamSide)
      .map((row) => ({
        playerId: text(row.player_id),
        name: text(row.player_name),
        ...(row.batting_order === null ? {} : { battingOrder: number(row.batting_order) }),
        starter: boolean(row.starter),
        positions: (positions.get(`${teamSide}:${number(row.roster_index)}`) ?? []).map((item) =>
          text(item.position),
        ),
      })),
  });
  const rosters: StagingGameDocumentV2["rosters"] = {
    away: roster("away"),
    home: roster("home"),
  };
  const events = hydrateEvents(tables);
  const trackingCandidates = tables.tracking_observations.map((row) => {
    const resolutionKind = text(row.resolution_kind);
    const resolution =
      resolutionKind === "pending"
        ? ({ kind: "pending" } as const)
        : resolutionKind === "linked"
          ? ({
              kind: "linked",
              pitchEventId: requiredNullableText(row.pitch_event_id, "tracking pitch event"),
            } as const)
          : resolutionKind === "duplicate"
            ? ({
                kind: "duplicate",
                canonicalTrackingId: requiredNullableText(
                  row.canonical_tracking_id,
                  "tracking canonical ID",
                ),
              } as const)
            : resolutionKind === "excluded"
              ? ({
                  kind: "excluded",
                  reason: trackingExclusionReason(
                    requiredNullableText(row.exclusion_reason, "tracking 제외 사유"),
                  ),
                  ...(row.exclusion_note === null ? {} : { note: text(row.exclusion_note) }),
                } as const)
              : (() => {
                  throw new PersistenceIntegrityError(
                    `알 수 없는 tracking resolution입니다: ${resolutionKind}`,
                  );
                })();
    return {
      trackingId: text(row.tracking_id),
      source: {
        endpoint: text(row.source_endpoint),
        blockIndex: number(row.source_block_index),
        rowIndex: number(row.source_row_index),
      },
      ...(row.source_pitch_id === null ? {} : { sourcePitchId: text(row.source_pitch_id) }),
      sourcePitchOrdinal:
        row.source_pitch_ordinal === null ? null : number(row.source_pitch_ordinal),
      sequence: number(row.tracking_sequence),
      inning: number(row.inning),
      half: half(row.half),
      ...(row.plate_appearance_event_id === null
        ? {}
        : { plateAppearanceEventId: text(row.plate_appearance_event_id) }),
      ...(row.pitcher_id === null ? {} : { pitcherId: text(row.pitcher_id) }),
      ...(row.batter_id === null ? {} : { batterId: text(row.batter_id) }),
      ...(row.observed_at === null ? {} : { observedAt: text(row.observed_at) }),
      ...(row.stance === null ? {} : { stance: stance(row.stance) }),
      ...trackingNumbersFromRow(row),
      resolution,
    };
  });
  return parseStagingGameDocumentV2({
    schemaVersion: 2,
    source: {
      provider: "naver",
      sourceGameId: manifest.source_game_id,
      collectedAt: manifest.collected_at_text,
      sourceBundleHash: manifest.source_bundle_hash,
    },
    revisionBase:
      manifest.parent_revision === null || manifest.base_document_hash === null
        ? { kind: "new_game" }
        : {
            kind: "sealed_revision",
            revision: manifest.parent_revision,
            documentHash: manifest.base_document_hash,
          },
    metadata: {
      gameId: manifest.game_id,
      season: manifest.season,
      gameDate: dateText(manifest.game_date),
      ...(manifest.scheduled_at_text === null ? {} : { scheduledAt: manifest.scheduled_at_text }),
      status: manifest.game_status,
      ...(manifest.stadium === null ? {} : { stadium: manifest.stadium }),
      scheduledInnings: manifest.scheduled_innings,
    },
    teams,
    rosters,
    events,
    trackingCandidates,
    officialRecords: {
      batters: tables.official_batter_lines.map((row) => ({
        playerId: text(row.player_id),
        side: side(row.side),
        ...(row.plate_appearances === null
          ? {}
          : { plateAppearances: number(row.plate_appearances) }),
        atBats: number(row.at_bats),
        runs: number(row.runs),
        hits: number(row.hits),
        ...(row.doubles === null ? {} : { doubles: number(row.doubles) }),
        ...(row.triples === null ? {} : { triples: number(row.triples) }),
        homeRuns: number(row.home_runs),
        runsBattedIn: number(row.runs_batted_in),
        walks: number(row.walks),
        ...(row.intentional_walks === null
          ? {}
          : { intentionalWalks: number(row.intentional_walks) }),
        ...(row.hit_by_pitch === null ? {} : { hitByPitch: number(row.hit_by_pitch) }),
        strikeouts: number(row.strikeouts),
        ...(row.sacrifice_bunts === null ? {} : { sacrificeBunts: number(row.sacrifice_bunts) }),
        ...(row.sacrifice_flies === null ? {} : { sacrificeFlies: number(row.sacrifice_flies) }),
      })),
      pitchers: tables.official_pitcher_lines.map((row) => ({
        playerId: text(row.player_id),
        side: side(row.side),
        battersFaced: number(row.batters_faced),
        outsRecorded: number(row.outs_recorded),
        hits: number(row.hits),
        runs: number(row.runs),
        earnedRuns: number(row.earned_runs),
        walks: number(row.walks),
        ...(row.intentional_walks === null
          ? {}
          : { intentionalWalks: number(row.intentional_walks) }),
        hitByPitch: number(row.hit_by_pitch),
        strikeouts: number(row.strikeouts),
        ...(row.pitches === null ? {} : { pitches: number(row.pitches) }),
        ...(row.strikes === null ? {} : { strikes: number(row.strikes) }),
      })),
    },
  });
}

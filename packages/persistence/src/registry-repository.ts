import type {
  RegistryRegistrationPlayer,
  RegistrySeasonDataset,
  RegistryStatusEvent,
} from "@kbo/contracts";
import { parseRegistrySeasonDataset } from "@kbo/contracts";
import type { Pool, PoolClient } from "pg";

export interface RegistryDateRange {
  readonly dateFrom: string;
  readonly dateTo: string;
}

export interface ImportedRegistryRevision {
  readonly season: number;
  readonly revision: number;
  readonly sourceBundleHash: string;
  readonly warningCount: number;
}

interface ResolutionIssue {
  readonly eventSequence: number | null;
  readonly code: string;
  readonly severity: "warning" | "blocking";
  readonly message: string;
  readonly candidateCount: number;
}

interface ResolvedStatusEvent {
  readonly event: RegistryStatusEvent;
  readonly teamIdentityKey: string | null;
  readonly playerIdentityKey: string | null;
  readonly resolutionKind: "official" | "exact_external_and_name" | "unique_context" | "unresolved";
}

interface Stint {
  readonly kind: "first_team_registration" | "organization_affiliation";
  readonly playerIdentityKey: string;
  readonly teamIdentityKey: string;
  readonly validFrom: string | null;
  readonly validTo: string | null;
  readonly leftCensored: boolean;
  readonly rightCensored: boolean;
  readonly startEventSequence: number | null;
  readonly endEventSequence: number | null;
}

export class RegistryRepository {
  public constructor(
    private readonly pool: Pool,
    private readonly expectedMigrationVersion: string,
  ) {}

  public async seasonDateRange(season: number): Promise<RegistryDateRange> {
    const result = await this.pool.query<{
      readonly date_from: string | null;
      readonly date_to: string | null;
    }>(
      `SELECT MIN(r.game_date)::text date_from,MAX(r.game_date)::text date_to
       FROM workbench.games g JOIN workbench.game_revisions r
         ON r.game_id=g.game_id AND r.revision=g.current_revision
       WHERE r.season=$1 AND r.sealed`,
      [season],
    );
    const row = result.rows[0];
    if (row === undefined || row.date_from === null || row.date_to === null)
      throw new Error(`${String(season)} 시즌의 sealed 경기가 없습니다.`);
    return { dateFrom: row.date_from, dateTo: row.date_to };
  }

  public async importSeason(
    runId: string,
    input: unknown,
    sourceBundleHash: string,
  ): Promise<ImportedRegistryRevision> {
    const dataset = parseRegistrySeasonDataset(input);
    assertDatasetComplete(dataset);
    if (!/^[0-9a-f]{64}$/.test(sourceBundleHash))
      throw new Error("registry source bundle hash가 올바르지 않습니다.");
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await assertRegistryContract(client, this.expectedMigrationVersion);
      await client.query(
        `INSERT INTO catalog.seasons (competition_id,season)
         VALUES ('kbo',$1) ON CONFLICT DO NOTHING`,
        [dataset.season],
      );
      const revision = await nextRegistryRevision(client, dataset.season);
      const startedAt =
        dataset.sourcePages.map((page) => page.collectedAt).sort()[0] ?? new Date().toISOString();
      const finishedAt =
        dataset.sourcePages
          .map((page) => page.collectedAt)
          .sort()
          .at(-1) ?? startedAt;
      await client.query(
        `INSERT INTO registry.collection_runs
           (run_id,season,date_from,date_to,status,dry_run,started_at,finished_at,source_bundle_hash)
         VALUES ($1,$2,$3,$4,'parsed',FALSE,$5,$6,$7)`,
        [
          runId,
          dataset.season,
          dataset.dateFrom,
          dataset.dateTo,
          startedAt,
          finishedAt,
          sourceBundleHash,
        ],
      );
      await client.query(
        `INSERT INTO registry.season_revisions
           (season,revision,run_id,source_bundle_hash,blocking_count,warning_count)
         VALUES ($1,$2,$3,$4,0,0)`,
        [dataset.season, revision, runId, sourceBundleHash],
      );
      const pageSequences = new Map<string, number>();
      for (const [pageSequence, page] of dataset.sourcePages.entries()) {
        pageSequences.set(page.requestKey, pageSequence);
        await client.query(
          `INSERT INTO registry.source_pages
             (season,revision,page_sequence,page_kind,request_key,artifact_key,content_hash,collected_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
          [
            dataset.season,
            revision,
            pageSequence,
            page.pageKind,
            page.requestKey,
            page.artifactKey,
            page.contentHash,
            page.collectedAt,
          ],
        );
      }

      const teamIdentities = await upsertRegistryTeams(client, dataset);
      await upsertRegistryPlayers(client, dataset, teamIdentities);
      await insertRegistrationSnapshots(client, dataset, revision, pageSequences, teamIdentities);
      const { events, issues } = resolveStatusEvents(dataset, teamIdentities);
      await insertStatusEvents(client, dataset.season, revision, events, pageSequences);
      const stints = [
        ...firstTeamStints(dataset, teamIdentities),
        ...organizationStints(events, issues),
      ];
      await insertIssues(client, dataset.season, revision, issues);
      await insertStints(client, dataset.season, revision, stints);
      await client.query(
        `UPDATE registry.season_revisions
         SET warning_count=$3,sealed=TRUE,sealed_at=CURRENT_TIMESTAMP
         WHERE season=$1 AND revision=$2`,
        [dataset.season, revision, issues.filter((issue) => issue.severity === "warning").length],
      );
      await client.query(
        "UPDATE registry.season_current_revisions SET current_revision=$2 WHERE season=$1",
        [dataset.season, revision],
      );
      await client.query("UPDATE registry.collection_runs SET status='sealed' WHERE run_id=$1", [
        runId,
      ]);
      await client.query("COMMIT");
      return {
        season: dataset.season,
        revision,
        sourceBundleHash,
        warningCount: issues.filter((issue) => issue.severity === "warning").length,
      };
    } catch (error: unknown) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }
}

async function assertRegistryContract(
  client: PoolClient,
  expectedMigration: string,
): Promise<void> {
  const migration = await client.query<{ readonly version: string }>(
    "SELECT version FROM workbench.schema_migrations ORDER BY version DESC LIMIT 1",
  );
  const contract = await client.query<{
    readonly analytics_contract_version: number;
    readonly projection_version: number;
    readonly registry_contract_version: number;
  }>(
    "SELECT analytics_contract_version,projection_version,registry_contract_version FROM workbench.contract_metadata WHERE singleton",
  );
  if (
    migration.rows[0]?.version !== expectedMigration ||
    contract.rows[0]?.analytics_contract_version !== 3 ||
    contract.rows[0]?.projection_version !== 3 ||
    contract.rows[0]?.registry_contract_version !== 1
  ) {
    throw new Error("registry DB contract가 V3 3/3/1과 일치하지 않습니다.");
  }
}

async function nextRegistryRevision(client: PoolClient, season: number): Promise<number> {
  await client.query(
    "INSERT INTO registry.season_current_revisions (season,current_revision) VALUES ($1,NULL) ON CONFLICT DO NOTHING",
    [season],
  );
  const current = await client.query<{ readonly current_revision: number | null }>(
    "SELECT current_revision FROM registry.season_current_revisions WHERE season=$1 FOR UPDATE",
    [season],
  );
  return (current.rows[0]?.current_revision ?? 0) + 1;
}

async function upsertRegistryTeams(
  client: PoolClient,
  dataset: RegistrySeasonDataset,
): Promise<ReadonlyMap<string, string>> {
  const byCode = new Map<string, string>();
  const teams = new Map(
    dataset.registrationSnapshots.map((snapshot) => [snapshot.teamCode, snapshot.teamName]),
  );
  for (const [teamCode, teamName] of [...teams].sort(([left], [right]) =>
    left.localeCompare(right),
  )) {
    const candidates = await client.query<{ readonly team_id: string }>(
      `SELECT DISTINCT i.team_id FROM catalog.team_name_observations n
       JOIN catalog.team_identities i USING (identity_key)
       WHERE n.display_name=$1`,
      [teamName],
    );
    const canonicalTeamId =
      candidates.rows.length === 1 ? candidates.rows[0]?.team_id : `kbo:${teamCode}`;
    if (canonicalTeamId === undefined) throw new Error("team identity 후보가 없습니다.");
    const identityKey = `kbo:${teamCode}`;
    await client.query(
      `INSERT INTO catalog.teams (team_id,provisional) VALUES ($1,FALSE)
       ON CONFLICT (team_id) DO UPDATE SET provisional=FALSE`,
      [canonicalTeamId],
    );
    await client.query(
      `INSERT INTO catalog.team_identities (identity_key,provider,external_team_id,team_id)
       VALUES ($1,'kbo',$2,$3)
       ON CONFLICT (identity_key) DO UPDATE SET team_id=EXCLUDED.team_id`,
      [identityKey, teamCode, canonicalTeamId],
    );
    for (const snapshot of dataset.registrationSnapshots.filter(
      (item) => item.teamCode === teamCode,
    )) {
      await client.query(
        `INSERT INTO catalog.team_name_observations
           (identity_key,observed_on,display_name,source_ref)
         VALUES ($1,$2,$3,$4) ON CONFLICT DO NOTHING`,
        [identityKey, snapshot.snapshotDate, snapshot.teamName, snapshot.sourceRequestKey],
      );
    }
    await client.query(
      `INSERT INTO catalog.team_seasons (competition_id,season,team_id)
       VALUES ('kbo',$1,$2) ON CONFLICT DO NOTHING`,
      [dataset.season, canonicalTeamId],
    );
    byCode.set(teamCode, identityKey);
  }
  return byCode;
}

async function upsertRegistryPlayers(
  client: PoolClient,
  dataset: RegistrySeasonDataset,
  teams: ReadonlyMap<string, string>,
): Promise<void> {
  const players = new Map<string, RegistryRegistrationPlayer>();
  for (const snapshot of dataset.registrationSnapshots)
    for (const player of snapshot.players) players.set(player.playerId, player);
  for (const player of [...players.values()].sort((left, right) =>
    left.playerId.localeCompare(right.playerId),
  )) {
    const canonicalPlayerId = `kbo:${player.playerId}`;
    const identityKey = canonicalPlayerId;
    await client.query(
      "INSERT INTO catalog.players (player_id,provisional) VALUES ($1,FALSE) ON CONFLICT DO NOTHING",
      [canonicalPlayerId],
    );
    await client.query(
      `INSERT INTO catalog.player_identities
         (identity_key,provider,external_player_id,player_id,resolution_kind)
       VALUES ($1,'kbo',$2,$1,'official') ON CONFLICT (identity_key) DO NOTHING`,
      [identityKey, player.playerId],
    );
    const observations = dataset.registrationSnapshots
      .flatMap((snapshot) =>
        snapshot.players
          .filter((item) => item.playerId === player.playerId)
          .map((item) => ({ snapshot, item })),
      )
      .sort(
        (left, right) =>
          left.snapshot.snapshotDate.localeCompare(right.snapshot.snapshotDate) ||
          left.item.playerName.localeCompare(right.item.playerName),
      );
    for (const observation of observations) {
      await client.query(
        `INSERT INTO catalog.player_name_observations
           (identity_key,observed_on,display_name,source_ref)
         VALUES ($1,$2,$3,$4) ON CONFLICT DO NOTHING`,
        [
          identityKey,
          observation.snapshot.snapshotDate,
          observation.item.playerName,
          observation.snapshot.sourceRequestKey,
        ],
      );
    }
    let candidate: string | undefined;
    for (const displayName of [
      ...new Set(observations.map((item) => item.item.playerName)),
    ].sort()) {
      const exact = await client.query<{ readonly identity_key: string }>(
        `SELECT DISTINCT i.identity_key FROM catalog.player_identities i
         JOIN catalog.player_name_observations n USING (identity_key)
         WHERE i.provider='naver' AND i.external_player_id=$1 AND n.display_name=$2`,
        [player.playerId, displayName],
      );
      if (exact.rows.length === 1) candidate = exact.rows[0]?.identity_key;
    }
    let resolutionKind: "exact_external_and_name" | "unique_context" = "exact_external_and_name";
    if (candidate === undefined) {
      const teamIdentity = teams.get(player.teamCode);
      const teamName = player.teamName;
      const contextual = await client.query<{ readonly identity_key: string }>(
        `SELECT DISTINCT roster.player_identity_key identity_key
         FROM workbench.game_roster_snapshots roster
         JOIN workbench.game_team_snapshots team
           ON team.game_id=roster.game_id AND team.revision=roster.revision AND team.side=roster.side
         JOIN workbench.game_revisions revision
           ON revision.game_id=roster.game_id AND revision.revision=roster.revision
         JOIN workbench.game_roster_positions position
           ON position.game_id=roster.game_id AND position.revision=roster.revision
          AND position.side=roster.side AND position.roster_index=roster.roster_index
         WHERE revision.season=$1 AND roster.player_name=$2 AND team.team_name=$3
           AND ($4='' OR position.position LIKE '%' || $4 || '%')`,
        [dataset.season, player.playerName, teamName, positionStem(player.positionText)],
      );
      if (teamIdentity !== undefined && contextual.rows.length === 1) {
        candidate = contextual.rows[0]?.identity_key;
        resolutionKind = "unique_context";
      }
    }
    if (candidate !== undefined) {
      const old = await client.query<{ readonly player_id: string }>(
        "SELECT player_id FROM catalog.player_identities WHERE identity_key=$1",
        [candidate],
      );
      await client.query(
        `UPDATE catalog.player_identities SET player_id=$2,resolution_kind=$3
         WHERE identity_key=$1`,
        [candidate, canonicalPlayerId, resolutionKind],
      );
      const oldPlayerId = old.rows[0]?.player_id;
      if (oldPlayerId !== undefined && oldPlayerId !== canonicalPlayerId)
        await client.query(
          "UPDATE catalog.players SET merged_into_player_id=$2 WHERE player_id=$1",
          [oldPlayerId, canonicalPlayerId],
        );
    }
  }
}

async function insertRegistrationSnapshots(
  client: PoolClient,
  dataset: RegistrySeasonDataset,
  revision: number,
  pageSequences: ReadonlyMap<string, number>,
  teams: ReadonlyMap<string, string>,
): Promise<void> {
  for (const snapshot of dataset.registrationSnapshots) {
    const teamIdentity = teams.get(snapshot.teamCode);
    const pageSequence = pageSequences.get(snapshot.sourceRequestKey);
    if (teamIdentity === undefined || pageSequence === undefined)
      throw new Error(`registry snapshot 참조가 없습니다: ${snapshot.sourceRequestKey}`);
    await client.query(
      `INSERT INTO registry.registration_snapshots
         (season,revision,snapshot_date,team_identity_key,source_page_sequence,complete)
       VALUES ($1,$2,$3,$4,$5,$6)`,
      [
        dataset.season,
        revision,
        snapshot.snapshotDate,
        teamIdentity,
        pageSequence,
        snapshot.complete,
      ],
    );
    for (const [playerOrder, player] of snapshot.players.entries())
      await client.query(
        `INSERT INTO registry.registration_snapshot_players
           (season,revision,snapshot_date,team_identity_key,player_order,player_identity_key,
            roster_category,uniform_number,position_text,throws_bats,birth_date,height_cm,weight_kg)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
        [
          dataset.season,
          revision,
          snapshot.snapshotDate,
          teamIdentity,
          playerOrder,
          `kbo:${player.playerId}`,
          player.rosterCategory,
          player.uniformNumber,
          player.positionText,
          player.throwsBats,
          player.birthDate,
          player.heightCm,
          player.weightKg,
        ],
      );
  }
}

function resolveStatusEvents(
  dataset: RegistrySeasonDataset,
  teams: ReadonlyMap<string, string>,
): { readonly events: ResolvedStatusEvent[]; readonly issues: ResolutionIssue[] } {
  const teamByName = new Map<string, string>();
  for (const snapshot of dataset.registrationSnapshots) {
    const identity = teams.get(snapshot.teamCode);
    if (identity !== undefined) teamByName.set(snapshot.teamName, identity);
  }
  const candidates = new Map<string, Set<string>>();
  for (const snapshot of dataset.registrationSnapshots) {
    for (const player of snapshot.players) {
      const key = statusCandidateKey(snapshot.teamName, player.playerName, player.positionText);
      const values = candidates.get(key) ?? new Set<string>();
      values.add(`kbo:${player.playerId}`);
      candidates.set(key, values);
    }
  }
  const issues: ResolutionIssue[] = [];
  const events = dataset.statusEvents.map((event, eventSequence): ResolvedStatusEvent => {
    const key = statusCandidateKey(event.teamName, event.rawPlayerName, event.rawPosition ?? "");
    const matches = [...(candidates.get(key) ?? [])].sort();
    if (event.eventKind === "unknown")
      issues.push({
        eventSequence,
        code: "registry.unknown_status_category",
        severity: "warning",
        message: `알 수 없는 선수이동 항목: ${event.rawCategory}`,
        candidateCount: matches.length,
      });
    if (matches.length !== 1)
      issues.push({
        eventSequence,
        code: matches.length === 0 ? "registry.player_unresolved" : "registry.player_ambiguous",
        severity: "warning",
        message: `${event.teamName} ${event.rawPlayerName} 선수를 유일하게 식별할 수 없습니다.`,
        candidateCount: matches.length,
      });
    return {
      event,
      teamIdentityKey: teamByName.get(event.teamName) ?? null,
      playerIdentityKey: matches.length === 1 ? (matches[0] ?? null) : null,
      resolutionKind: matches.length === 1 ? "unique_context" : "unresolved",
    };
  });
  return { events, issues };
}

async function insertStatusEvents(
  client: PoolClient,
  season: number,
  revision: number,
  events: readonly ResolvedStatusEvent[],
  pageSequences: ReadonlyMap<string, number>,
): Promise<void> {
  for (const [eventSequence, resolved] of events.entries()) {
    const pageSequence = pageSequences.get(resolved.event.sourceRequestKey);
    if (pageSequence === undefined)
      throw new Error(`status event source page가 없습니다: ${resolved.event.sourceRequestKey}`);
    await client.query(
      `INSERT INTO registry.status_events
         (season,revision,event_sequence,effective_date,raw_category,event_kind,affiliation_effect,
          team_identity_key,raw_player_name,raw_position,raw_note,player_identity_key,resolution_kind,
          source_page_sequence,source_row_index)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)`,
      [
        season,
        revision,
        eventSequence,
        resolved.event.effectiveDate,
        resolved.event.rawCategory,
        resolved.event.eventKind,
        resolved.event.affiliationEffect,
        resolved.teamIdentityKey,
        resolved.event.rawPlayerName,
        resolved.event.rawPosition,
        resolved.event.rawNote,
        resolved.playerIdentityKey,
        resolved.resolutionKind,
        pageSequence,
        resolved.event.sourceRowIndex,
      ],
    );
  }
}

function firstTeamStints(
  dataset: RegistrySeasonDataset,
  teams: ReadonlyMap<string, string>,
): Stint[] {
  const daysByPlayerTeam = new Map<string, string[]>();
  for (const snapshot of dataset.registrationSnapshots) {
    const teamIdentity = teams.get(snapshot.teamCode);
    if (!snapshot.complete || teamIdentity === undefined) continue;
    for (const player of snapshot.players) {
      const key = `${teamIdentity}\u0000kbo:${player.playerId}`;
      const days = daysByPlayerTeam.get(key) ?? [];
      days.push(snapshot.snapshotDate);
      daysByPlayerTeam.set(key, days);
    }
  }
  const result: Stint[] = [];
  for (const [key, unsortedDays] of [...daysByPlayerTeam].sort(([left], [right]) =>
    left.localeCompare(right),
  )) {
    const separator = key.indexOf("\u0000");
    const teamIdentityKey = key.slice(0, separator);
    const playerIdentityKey = key.slice(separator + 1);
    const days = [...new Set(unsortedDays)].sort();
    let start = days[0];
    let previous = days[0];
    for (const day of [...days.slice(1), null]) {
      if (day !== null && previous !== undefined && day === addDays(previous, 1)) {
        previous = day;
        continue;
      }
      if (start !== undefined && previous !== undefined)
        result.push({
          kind: "first_team_registration",
          playerIdentityKey,
          teamIdentityKey,
          validFrom: start,
          validTo: addDays(previous, 1),
          leftCensored: start === dataset.dateFrom,
          rightCensored: previous === dataset.dateTo,
          startEventSequence: null,
          endEventSequence: null,
        });
      start = day ?? undefined;
      previous = day ?? undefined;
    }
  }
  return result;
}

function organizationStints(
  events: readonly ResolvedStatusEvent[],
  issues: ResolutionIssue[],
): Stint[] {
  const result: Stint[] = [];
  const active = new Map<string, { readonly date: string; readonly eventSequence: number }>();
  events.forEach((resolved, eventSequence) => {
    if (resolved.playerIdentityKey === null || resolved.teamIdentityKey === null) return;
    const key = `${resolved.playerIdentityKey}\u0000${resolved.teamIdentityKey}`;
    if (resolved.event.affiliationEffect === "start") {
      active.set(key, { date: resolved.event.effectiveDate, eventSequence });
    } else if (resolved.event.affiliationEffect === "end") {
      const start = active.get(key);
      result.push({
        kind: "organization_affiliation",
        playerIdentityKey: resolved.playerIdentityKey,
        teamIdentityKey: resolved.teamIdentityKey,
        validFrom: start?.date ?? null,
        validTo: resolved.event.effectiveDate,
        leftCensored: start === undefined,
        rightCensored: false,
        startEventSequence: start?.eventSequence ?? null,
        endEventSequence: eventSequence,
      });
      active.delete(key);
    } else if (resolved.event.affiliationEffect === "transfer") {
      issues.push({
        eventSequence,
        code: "registry.transfer_direction_unresolved",
        severity: "warning",
        message: "선수이동 행만으로 이적 방향을 확정하지 않았습니다.",
        candidateCount: 1,
      });
    }
  });
  for (const [key, start] of [...active].sort(([left], [right]) => left.localeCompare(right))) {
    const separator = key.indexOf("\u0000");
    result.push({
      kind: "organization_affiliation",
      playerIdentityKey: key.slice(0, separator),
      teamIdentityKey: key.slice(separator + 1),
      validFrom: start.date,
      validTo: null,
      leftCensored: false,
      rightCensored: true,
      startEventSequence: start.eventSequence,
      endEventSequence: null,
    });
  }
  return result;
}

async function insertIssues(
  client: PoolClient,
  season: number,
  revision: number,
  issues: readonly ResolutionIssue[],
): Promise<void> {
  for (const [issueSequence, issue] of issues.entries())
    await client.query(
      `INSERT INTO registry.identity_resolution_issues
         (season,revision,issue_sequence,status_event_sequence,code,severity,message,candidate_count)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [
        season,
        revision,
        issueSequence,
        issue.eventSequence,
        issue.code,
        issue.severity,
        issue.message,
        issue.candidateCount,
      ],
    );
}

async function insertStints(
  client: PoolClient,
  season: number,
  revision: number,
  stints: readonly Stint[],
): Promise<void> {
  for (const [stintSequence, stint] of stints.entries())
    await client.query(
      `INSERT INTO registry.player_team_stints
         (season,revision,stint_sequence,stint_kind,player_identity_key,team_identity_key,
          valid_from,valid_to,left_censored,right_censored,start_status_event_sequence,end_status_event_sequence)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
      [
        season,
        revision,
        stintSequence,
        stint.kind,
        stint.playerIdentityKey,
        stint.teamIdentityKey,
        stint.validFrom,
        stint.validTo,
        stint.leftCensored,
        stint.rightCensored,
        stint.startEventSequence,
        stint.endEventSequence,
      ],
    );
}

function statusCandidateKey(teamName: string, playerName: string, position: string): string {
  return `${teamName.normalize("NFC")}\u0000${playerName.normalize("NFC")}\u0000${positionStem(position)}`;
}

function positionStem(position: string): string {
  return position.replace(/수$/, "").trim().normalize("NFC");
}

function addDays(value: string, days: number): string {
  const date = new Date(`${value}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

function assertDatasetComplete(dataset: RegistrySeasonDataset): void {
  const sourceKeys = new Set(dataset.sourcePages.map((page) => page.requestKey));
  if (sourceKeys.size !== dataset.sourcePages.length) {
    throw new Error("registry source request key가 중복되었습니다.");
  }
  for (const snapshot of dataset.registrationSnapshots) {
    if (!snapshot.complete) {
      throw new Error(`필수 KBO 등록 snapshot이 완전하지 않습니다: ${snapshot.sourceRequestKey}`);
    }
    if (!sourceKeys.has(snapshot.sourceRequestKey)) {
      throw new Error(`KBO 등록 snapshot 원문 page가 없습니다: ${snapshot.sourceRequestKey}`);
    }
  }
  for (const event of dataset.statusEvents) {
    if (!sourceKeys.has(event.sourceRequestKey)) {
      throw new Error(`KBO 선수이동 event 원문 page가 없습니다: ${event.sourceRequestKey}`);
    }
  }
}

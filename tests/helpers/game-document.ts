type EventSpec = Readonly<{
  kind: string;
  payload: unknown;
  inning?: number;
  half?: "top" | "bottom";
  relayText?: string;
  observedStateAfter?: unknown;
}>;

type LegacyMovement = Readonly<{
  runnerId: string;
  fromBase: number;
  toBase: number;
  outcome: "safe" | "out" | "scored";
  sequence: number;
  outKind?: string;
  supersedesThirdOut?: boolean;
  responsiblePitcherId?: string;
  relayText?: string;
}>;

/** 테스트 입력도 실제 외부 계약과 같은 평면 원장으로 만든다. */
export function makeDocument(specs: readonly EventSpec[], status = "suspended"): unknown {
  const normalized = flattenSpecs(specs);
  return {
    schemaVersion: 2,
    source: {
      provider: "naver",
      sourceGameId: "test-source-game",
      collectedAt: "2026-08-20T12:00:00+09:00",
      sourceBundleHash: "0".repeat(64),
    },
    revisionBase: { kind: "new_game" },
    metadata: {
      gameId: "test-game",
      season: 2026,
      gameDate: "2026-08-20",
      status,
      scheduledInnings: 9,
    },
    teams: {
      away: { teamId: "AWAY", name: "원정" },
      home: { teamId: "HOME", name: "홈" },
    },
    rosters: {
      away: {
        teamId: "AWAY",
        players: ["a1", "a2", "a3", "a4", "a5", "a6", "a7", "a8", "a9", "ar1"].map(
          (playerId, index) => ({
            playerId,
            name: playerId,
            ...(index < 9 ? { battingOrder: index + 1 } : {}),
            starter: index < 9,
            positions: [index === 9 ? "PR" : "IF"],
          }),
        ),
      },
      home: {
        teamId: "HOME",
        players: ["h1", "h2", "h3", "hp1", "hp2"].map((playerId, index) => ({
          playerId,
          name: playerId,
          starter: index < 4,
          positions: [playerId.startsWith("hp") ? "P" : "IF"],
        })),
      },
    },
    events: normalized.map((spec, sequence) => ({
      identity: {
        kind: "source",
        eventId: `e${String(sequence)}`,
        endpoint: "test-relay",
        blockIndex: 0,
        eventIndex: sequence,
      },
      sequence,
      inning: spec.inning ?? 1,
      half: spec.half ?? "top",
      kind: spec.kind,
      payload: spec.payload,
      ...(spec.relayText === undefined ? {} : { relayText: spec.relayText }),
      ...(spec.observedStateAfter === undefined
        ? {}
        : { observedStateAfter: spec.observedStateAfter }),
    })),
    trackingCandidates: [],
    officialRecords: { batters: [], pitchers: [] },
  };
}

function flattenSpecs(specs: readonly EventSpec[]): EventSpec[] {
  const result: EventSpec[] = [];
  for (const spec of specs) {
    if (spec.kind === "plate_appearance_start") {
      result.push({ ...spec, kind: "batter_start" });
      continue;
    }
    if (spec.kind === "plate_appearance_result") {
      const payload = spec.payload as Record<string, unknown>;
      const movements = (payload.movements ?? []) as readonly LegacyMovement[];
      const batter = movements.find((movement) => movement.fromBase === 0);
      const platePayload = Object.fromEntries(
        Object.entries(payload).filter(([key]) => key !== "movements"),
      );
      const plateResultId = `e${String(result.length)}`;
      result.push({
        ...spec,
        kind: "plate_result",
        payload: {
          ...platePayload,
          ...(batter !== undefined && batter.outcome !== "out" && batter.toBase < 4
            ? { batterDestination: batter.toBase }
            : {}),
        },
      });
      for (const movement of movements.filter((item) => item.fromBase > 0)) {
        const runner = runnerPayload(movement);
        const relayText = movement.relayText;
        result.push({
          kind: "runner_advance",
          inning: spec.inning,
          half: spec.half,
          ...(relayText === undefined ? {} : { relayText }),
          payload: {
            ...runner,
            context: { kind: "plate_result", plateResultEventId: plateResultId },
          },
        });
      }
      continue;
    }
    if (spec.kind === "runner_advance") {
      const payload = spec.payload as Record<string, unknown>;
      result.push({
        ...spec,
        payload:
          payload.context === undefined
            ? { ...payload, context: { kind: "independent", reason: "other" } }
            : payload,
      });
      continue;
    }
    if (spec.kind === "runner_play") {
      const payload = spec.payload as Record<string, unknown>;
      const movements = (payload.movements ?? []) as readonly LegacyMovement[];
      for (const movement of movements) {
        const runner = runnerPayload(movement);
        const relayText = movement.relayText;
        result.push({
          kind: "runner_advance",
          inning: spec.inning,
          half: spec.half,
          ...(relayText === undefined ? {} : { relayText }),
          payload: {
            ...runner,
            context: { kind: "independent", reason: String(payload.reason ?? "other") },
          },
        });
      }
      continue;
    }
    if (spec.kind === "half_inning_end") {
      result.push({
        ...spec,
        kind: "administrative",
        payload: { code: "footer" },
      });
      continue;
    }
    result.push(spec);
  }
  return result;
}

function runnerPayload(movement: LegacyMovement): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(movement).filter(([key]) => key !== "sequence" && key !== "relayText"),
  );
}

export function loadedBasesWithTwoOuts(): readonly EventSpec[] {
  return [
    { kind: "half_inning_start", payload: {} },
    ...intentionalWalk("a1", []),
    ...intentionalWalk("a2", [safe("a1", 1, 2, 0)]),
    ...intentionalWalk("a3", [safe("a1", 2, 3, 0), safe("a2", 1, 2, 1)]),
    ...fieldOut("a4"),
    ...fieldOut("a5"),
    { kind: "batter_start", payload: { batterId: "a6", pitcherId: "hp1" } },
  ];
}

export function safe(runnerId: string, fromBase: number, toBase: number, sequence: number) {
  return { runnerId, fromBase, toBase, outcome: "safe", sequence } as const;
}
export function scored(runnerId: string, fromBase: number, sequence: number) {
  return { runnerId, fromBase, toBase: 4, outcome: "scored", sequence } as const;
}
export function out(
  runnerId: string,
  fromBase: number,
  toBase: number,
  sequence: number,
  outKind: string,
  supersedesThirdOut = false,
) {
  return {
    runnerId,
    fromBase,
    toBase,
    outcome: "out",
    sequence,
    outKind,
    ...(supersedesThirdOut ? { supersedesThirdOut: true } : {}),
  } as const;
}

function intentionalWalk(
  batterId: string,
  forcedMovements: readonly unknown[],
): readonly EventSpec[] {
  return [
    { kind: "batter_start", payload: { batterId, pitcherId: "hp1" } },
    {
      kind: "plate_appearance_result",
      payload: {
        result: "intentional_walk",
        batterId,
        pitcherId: "hp1",
        creditedRbi: 0,
        movements: [...forcedMovements],
      },
    },
  ];
}
function fieldOut(batterId: string): readonly EventSpec[] {
  return [
    { kind: "batter_start", payload: { batterId, pitcherId: "hp1" } },
    {
      kind: "plate_result",
      payload: { result: "field_out", batterId, pitcherId: "hp1", creditedRbi: 0 },
    },
  ];
}

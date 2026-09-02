export interface RebuildFindingProjection {
  readonly gameId: string;
  readonly findings: readonly {
    readonly code: string;
    readonly severity: "warning" | "blocking";
  }[];
}

export function assertNoUnexpectedQuarantineIncrease(
  baselineQuarantined: number,
  projections: readonly RebuildFindingProjection[],
): void {
  const quarantined = projections.filter((projection) =>
    projection.findings.some((finding) => finding.severity === "blocking"),
  );
  if (quarantined.length <= baselineQuarantined) return;

  const gamesByCode = new Map<string, Set<string>>();
  for (const projection of quarantined) {
    for (const finding of projection.findings) {
      if (finding.severity !== "blocking") continue;
      const games = gamesByCode.get(finding.code) ?? new Set<string>();
      games.add(projection.gameId);
      gamesByCode.set(finding.code, games);
    }
  }
  const blockingCodeSummary = [...gamesByCode]
    .map(([code, gameIds]) => ({ code, games: gameIds.size }))
    .sort((left, right) => right.games - left.games || left.code.localeCompare(right.code))
    .slice(0, 5)
    .map(({ code, games }) => `${code}=${String(games)}`)
    .join(", ");

  throw new Error(
    `재생성 격리 경기가 증가했습니다: baseline=${String(baselineQuarantined)}, projected=${String(quarantined.length)}; blocking codes: ${blockingCodeSummary}`,
  );
}

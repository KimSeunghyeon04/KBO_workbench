export function assertSeason(season: number): void {
  if (!Number.isInteger(season) || season < 1982 || season > 9999) {
    throw new Error("허용되지 않은 season입니다.");
  }
}

export function assertGameId(gameId: string): void {
  if (!isGameId(gameId)) throw new Error("허용되지 않은 gameId입니다.");
}

export function assertJobId(jobId: string): void {
  if (!/^[A-Za-z0-9_-]{1,200}$/.test(jobId)) throw new Error("유효하지 않은 jobId입니다.");
}

export function isGameId(gameId: string): boolean {
  return /^[A-Za-z0-9_-]{1,100}$/.test(gameId);
}

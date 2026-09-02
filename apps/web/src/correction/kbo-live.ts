const KBO_LIVE_TEXT_ENDPOINT = "https://www.koreabaseball.com/Game/LiveText.aspx";
const KBO_GAME_ID = /^(?<officialId>(?<date>\d{8})[A-Z0-9]{4}\d)(?<sourceYear>\d{4})?$/;

export interface KboLiveTextLink {
  readonly url: string | null;
  readonly error: string | null;
}

export function buildKboLiveTextUrl(gameId: string): string {
  const normalized = gameId.trim().toUpperCase();
  const match = KBO_GAME_ID.exec(normalized);
  const groups = match?.groups;
  if (groups === undefined) {
    throw new Error(
      "경기 ID는 경기일 8자리와 팀·경기 코드 5자리, 선택적인 원천 연도 4자리 형식이어야 합니다.",
    );
  }
  const dateText = groups.date;
  const officialId = groups.officialId;
  if (dateText === undefined || officialId === undefined || !isValidDate(dateText)) {
    throw new Error("KBO 경기 ID의 경기일이 유효하지 않습니다.");
  }
  const year = Number(dateText.slice(0, 4));
  if (year < 1982) throw new Error("KBO 경기 ID의 연도는 1982년 이후여야 합니다.");
  const sourceYear = groups.sourceYear;
  if (sourceYear !== undefined && Number(sourceYear) !== year) {
    throw new Error("경기 ID 끝의 원천 연도가 경기일 연도와 다릅니다.");
  }
  const query = new URLSearchParams({
    leagueId: "1",
    seriesId: "0",
    gameId: officialId,
    gyear: String(year),
  });
  return `${KBO_LIVE_TEXT_ENDPOINT}?${query.toString()}`;
}

export function kboLiveTextLink(gameId: string | null | undefined): KboLiveTextLink {
  if (gameId === undefined || gameId === null || gameId.trim() === "") {
    return { url: null, error: "KBO 경기 ID를 선택하세요." };
  }
  try {
    return { url: buildKboLiveTextUrl(gameId), error: null };
  } catch (error: unknown) {
    return {
      url: null,
      error: error instanceof Error ? error.message : "KBO 문자중계 주소를 만들 수 없습니다.",
    };
  }
}

function isValidDate(value: string): boolean {
  const year = Number(value.slice(0, 4));
  const month = Number(value.slice(4, 6));
  const day = Number(value.slice(6, 8));
  const date = new Date(Date.UTC(year, month - 1, day));
  return (
    date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day
  );
}

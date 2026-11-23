import { load } from "cheerio";
import { kboPlayerProfileFields } from "./player-profile.js";

const clubNames = new Map([
  ["삼성", "삼성"],
  ["삼성라이온즈", "삼성"],
  ["LG", "LG"],
  ["LG트윈스", "LG"],
  ["KT", "KT"],
  ["KTWIZ", "KT"],
  ["KIA", "KIA"],
  ["KIA타이거즈", "KIA"],
  ["기아", "KIA"],
  ["두산", "두산"],
  ["두산베어스", "두산"],
  ["NC", "NC"],
  ["NC다이노스", "NC"],
  ["롯데", "롯데"],
  ["롯데자이언츠", "롯데"],
  ["한화", "한화"],
  ["한화이글스", "한화"],
  ["SSG", "SSG"],
  ["SSG랜더스", "SSG"],
  ["키움", "키움"],
  ["키움히어로즈", "키움"],
  ["해태", "해태"],
  ["해태타이거즈", "해태"],
  ["SK", "SK"],
  ["SK와이번스", "SK"],
  ["넥센", "넥센"],
  ["넥센히어로즈", "넥센"],
  ["우리", "우리"],
  ["우리히어로즈", "우리"],
  ["히어로즈", "히어로즈"],
  ["현대", "현대"],
  ["현대유니콘스", "현대"],
  ["태평양", "태평양"],
  ["청보", "청보"],
  ["삼미", "삼미"],
  ["쌍방울", "쌍방울"],
  ["OB", "OB"],
  ["OB베어스", "OB"],
  ["MBC", "MBC"],
  ["빙그레", "빙그레"],
]);
const previousNames = new Map([
  ["SK", "SSG"],
  ["해태", "KIA"],
  ["OB", "두산"],
  ["MBC", "LG"],
  ["빙그레", "한화"],
  ["넥센", "키움"],
  ["우리", "키움"],
  ["히어로즈", "키움"],
  ["삼미", "현대"],
  ["청보", "현대"],
  ["태평양", "현대"],
]);
const school =
  /(?:초|중|고|대|초교|중학|고교|대학교|대학|초등학교|중학교|고등학교|리틀)(?:\([^()]*\))*$/u;

function clubName(text: string): string | undefined {
  return clubNames.get(text.replace(/\s+/gu, "").toUpperCase());
}

function organization(club: string): string {
  return previousNames.get(club) ?? club;
}

export function parseKboPlayerCareerProfile(html: string, id: string) {
  const $ = load(html);
  const field = kboPlayerProfileFields($, id);
  if (!field) return null;
  const name = field("lblName");
  const position = /^(투수|포수|내야수|외야수)/u.exec(field("lblPosition"))?.[1];
  const join = /^(\d{4}|\d{2})\s*(.+)$/u.exec(field("lblJoinInfo"));
  const firstClub = join?.[2] && clubName(join[2]);
  const currentClub = clubName($("#h4Team").text());
  const seasonHeading = $(".player_records > h6").first();
  const lastSeason = Number(/^(\d{4})\s*성적$/u.exec(seasonHeading.text().trim())?.[1]);
  const rawYear = Number(join?.[1]);
  const firstSeason = rawYear < 82 ? 2000 + rawYear : rawYear < 100 ? 1900 + rawYear : rawYear;
  if (
    !name ||
    !position ||
    !firstClub ||
    !currentClub ||
    !Number.isInteger(lastSeason) ||
    !Number.isInteger(firstSeason) ||
    firstSeason < 1982 ||
    firstSeason > lastSeason
  )
    return null;
  const table = seasonHeading.nextAll("div.tbl-type02").first().find("table").first();
  const gamesColumn = table
    .find("thead th")
    .toArray()
    .findIndex((cell) => $(cell).text().trim() === "G");
  const playedClubs =
    gamesColumn > 0
      ? table
          .find("tbody tr")
          .toArray()
          .flatMap((row) => {
            const cells = $(row).find("td");
            const team = clubName(cells.first().text());
            return team && Number(cells.eq(gamesColumn).text().trim()) > 0 ? [team] : [];
          })
      : [];
  if (playedClubs.length === 0) return null;

  const clubs = [firstClub];
  const recordedCareer = field("lblCareer");
  if (!recordedCareer) return null;
  for (const item of recordedCareer.replace(/\([^()]*\)/gu, "").split(/\s*[-–→]\s*/u)) {
    const known = clubName(item);
    if (known) {
      if (organization(known) !== organization(clubs.at(-1) ?? "")) clubs.push(known);
    } else if (!school.test(item.trim()) && !/^(상무|경찰|경찰청)$/u.test(item.trim())) {
      return null;
    }
  }
  if (organization(currentClub) !== organization(clubs.at(-1) ?? "")) clubs.push(currentClub);
  if (
    playedClubs.some((team) => !clubs.some((entry) => organization(team) === organization(entry)))
  )
    return null;
  return { playerId: id, name, position, firstSeason, lastSeason, clubs };
}

export function parseCareerMovement(input: {
  readonly effect: string;
  readonly note: string | null;
  readonly team: string;
}) {
  if (input.effect !== "transfer") return null;
  const [left, right, extra] = input.note?.split("→") ?? [];
  const from = left && clubName(left);
  const to = right && clubName(right);
  const team = clubName(input.team);
  if (
    !from ||
    !to ||
    extra !== undefined ||
    !team ||
    organization(team) !== organization(to) ||
    organization(from) === organization(to)
  )
    return null;
  return { from: organization(from), to: organization(to) };
}

export function careerClubKey(club: string): string {
  return organization(clubName(club) ?? club);
}

export function careerCoversObservedClubs(
  clubs: readonly string[],
  observed: readonly string[],
): boolean {
  const history = clubs.map(organization);
  let previous = "";
  let cursor = 0;
  for (const value of observed) {
    const known = clubName(value);
    if (!known) return false;
    const next = organization(known);
    if (next === previous) continue;
    const index = history.indexOf(next, cursor);
    if (index < 0) return false;
    cursor = index + 1;
    previous = next;
  }
  return true;
}

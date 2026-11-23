import { isCalendarDate } from "@kbo/contracts";
import { load, type CheerioAPI } from "cheerio";

export function kboPlayerProfileFields($: CheerioAPI, id: string) {
  const profile = $(".player_basic");
  const photo = profile.find("img[id$='_playerProfile_imgProgile']").attr("src") ?? "";
  if (!/^\d{5}$/.test(id) || !photo.endsWith(`/${id}.jpg`)) return null;
  return (label: string) =>
    profile.find(`span[id$='_playerProfile_${label}']`).text().trim().normalize("NFC");
}

export function parseKboPlayerBirthYear(html: string, id: string) {
  const field = kboPlayerProfileFields(load(html), id);
  if (!field) return null;
  const name = field("lblName");
  const birthday = /^(\d{4})\s*년\s*(\d{1,2})\s*월\s*(\d{1,2})\s*일$/u.exec(field("lblBirthday"));
  const [, year, month, day] = birthday ?? [];
  if (
    !name ||
    !year ||
    !month ||
    !day ||
    !isCalendarDate(`${year}-${month.padStart(2, "0")}-${day.padStart(2, "0")}`)
  )
    return null;
  return { name, birthYear: Number(year) };
}

export function hasKboPlayerSearchMatch(html: string, id: string, name: string): boolean {
  const $ = load(html);
  return $("table tbody a[href*='playerId=']")
    .toArray()
    .some((link) => {
      const href = $(link).attr("href");
      if (!href || $(link).text().trim().normalize("NFC") !== name) return false;
      const url = URL.parse(href, "https://www.koreabaseball.com");
      return (
        url?.origin === "https://www.koreabaseball.com" &&
        /^\/(?:Record\/Player\/(?:Hitter|Pitcher)Detail\/Basic|Record\/Retire\/(?:Hitter|Pitcher)|Futures\/Player\/(?:Hitter|Pitcher)Detail)\.aspx$/i.test(
          url.pathname,
        ) &&
        url.searchParams.get("playerId") === id
      );
    });
}

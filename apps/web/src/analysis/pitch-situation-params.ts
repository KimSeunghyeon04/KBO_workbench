const sharedKeys = ["pitchType", "stance", "balls", "strikes"] as const;
export const pitchSituationKeys = [...sharedKeys, "cohort"] as const;
export type PitchSituationKey = (typeof pitchSituationKeys)[number];

/** Only conditions accepted by both pitch outcomes and batter discipline travel together. */
export function sharedPitchSituationParams(params: URLSearchParams): Record<string, string> {
  return Object.fromEntries(
    sharedKeys.flatMap((key) => {
      const value = params.get(key);
      return value === null ? [] : [[key, value]];
    }),
  );
}

export function pitchSituationConditions(
  params: URLSearchParams,
): { key: PitchSituationKey; label: string }[] {
  const active: { key: PitchSituationKey; label: string }[] = [];
  const pitchType = params.get("pitchType");
  if (pitchType !== null) active.push({ key: "pitchType", label: `구종: ${pitchType}` });
  const stance = params.get("stance");
  if (stance !== null)
    active.push({
      key: "stance",
      label:
        stance === "L"
          ? "좌타자"
          : stance === "R"
            ? "우타자"
            : stance === "S"
              ? "스위치 타석"
              : `타석: ${stance}`,
    });
  const balls = params.get("balls");
  if (balls !== null) active.push({ key: "balls", label: `${balls}볼` });
  const strikes = params.get("strikes");
  if (strikes !== null) active.push({ key: "strikes", label: `${strikes}스트라이크` });
  if (params.has("cohort") && params.get("cohort") !== "all")
    active.push({
      key: "cohort",
      label:
        params.get("cohort") === "discipline" ? "선구안 표본" : `표본: ${params.get("cohort")}`,
    });
  return active;
}

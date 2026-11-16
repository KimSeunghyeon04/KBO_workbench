export const formatStatNumber = (value: number | null, digits = 3) =>
  value === null ? "—" : value.toFixed(digits);

export const formatStatPercent = (value: number | null) =>
  value === null ? "—" : `${(value * 100).toFixed(1)}%`;

export const formatInnings = (outs: number) =>
  `${Math.floor(outs / 3)}${outs % 3 === 0 ? "" : outs % 3 === 1 ? "⅓" : "⅔"}`;

import { modelValidationSeasons } from "./model-training-period.js";
import type { ParkEnvironmentRow, ParkEnvironmentModel, ParkEnvironmentFit } from "@kbo/contracts";
import {
  fitCountRegression,
  countMean,
  countInformation,
  invertCountInformation,
  countContrastEvaluator,
  type CountRegressionRow,
} from "./count-regression.js";
import { gameLossInterval } from "./game-bootstrap.js";
type Metric = ParkEnvironmentFit["metric"];
const unique = (values: readonly string[]) => [...new Set(values)].sort();
const exposure = (r: ParkEnvironmentRow, metric: Metric) =>
  metric === "home_runs" ? r.pa : r.completeHalves;
const response = (r: ParkEnvironmentRow, metric: Metric) =>
  metric === "home_runs" ? r.homeRuns : r.completeRuns;
const eligible = (r: ParkEnvironmentRow, metric: Metric) =>
  r.normalEnd && r.parkId !== null && exposure(r, metric) > 0;
function rowEncoder(
  fit: Pick<ParkEnvironmentFit, "columns" | "seasons" | "parks" | "teams" | "months" | "metric">,
) {
  const columns = new Map(fit.columns.map((c, i) => [c, i]));
  return (row: ParkEnvironmentRow): CountRegressionRow | null => {
    if (
      !eligible(row, fit.metric) ||
      row.parkId === null ||
      !fit.parks.includes(row.parkId) ||
      !fit.teams.includes(row.teamId) ||
      !fit.teams.includes(row.opponentId) ||
      !fit.months.includes(row.gameDate.slice(5, 7))
    )
      return null;
    const last = fit.seasons.at(-1);
    if (last === undefined) return null;
    // A future year uses the last fitted season intercept; validation never estimates a future effect.
    const season = row.season > last ? last : row.season;
    if (!fit.seasons.includes(season)) return null;
    const keys = [
      "intercept",
      ...(row.side === "home" ? ["home"] : []),
      `park:${row.parkId}`,
      `attack:${row.teamId}`,
      `defense:${row.opponentId}`,
      `season:${season}`,
      `month:${row.gameDate.slice(5, 7)}`,
    ];
    return {
      game: JSON.stringify([row.gameId, row.revision]),
      indices: keys.flatMap((k) => {
        const i = columns.get(k);
        return i === undefined ? [] : [i];
      }),
      exposure: exposure(row, fit.metric),
      y: response(row, fit.metric),
    };
  };
}
function dispersion(
  rows: readonly CountRegressionRow[],
  coefficients: readonly number[],
  width: number,
) {
  return rows.length <= width
    ? null
    : rows.reduce((s, r) => {
        const mu = countMean(r, coefficients);
        return s + (r.y - mu) ** 2 / Math.max(mu, 1e-10);
      }, 0) /
        (rows.length - width);
}
function fitParkModel(
  input: readonly ParkEnvironmentRow[],
  metric: Metric,
  through: number,
  withPark: boolean,
  lambda: number,
  family: ParkEnvironmentFit["family"],
  intervals = false,
): ParkEnvironmentFit {
  const rows = input.filter((r) => r.season <= through && eligible(r, metric)),
    parks = unique(rows.flatMap((r) => (r.parkId === null ? [] : [r.parkId]))),
    teams = unique(rows.flatMap((r) => [r.teamId, r.opponentId])),
    seasons = [...new Set(rows.map((r) => r.season))].sort((a, b) => a - b),
    months = unique(rows.map((r) => r.gameDate.slice(5, 7))),
    columns = [
      "intercept",
      "home",
      ...(withPark ? parks.slice(1).map((p) => `park:${p}`) : []),
      ...teams.slice(1).map((t) => `attack:${t}`),
      ...teams.slice(1).map((t) => `defense:${t}`),
      ...seasons.slice(1).map((y) => `season:${y}`),
      ...months.slice(1).map((m) => `month:${m}`),
    ],
    encode = rowEncoder({ columns, seasons, parks, teams, months, metric }),
    data = rows.flatMap((r) => {
      const value = encode(r);
      return value === null ? [] : [value];
    }),
    poisson = fitCountRegression(data, columns.length, lambda, 0);
  const alpha =
      family === "poisson"
        ? 0
        : Math.max(
            0.01,
            Math.min(
              5,
              data.reduce((s, r) => {
                const mu = countMean(r, poisson.coefficients);
                return s + (r.y - mu) ** 2 - r.y;
              }, 0) /
                Math.max(
                  1e-10,
                  data.reduce((s, r) => s + countMean(r, poisson.coefficients) ** 2, 0),
                ),
            ),
          ),
    fitted =
      family === "poisson" ? poisson : fitCountRegression(data, columns.length, lambda, alpha),
    identifiable =
      data.length >= columns.length &&
      invertCountInformation(countInformation(data, fitted.coefficients, alpha)) !== null,
    trainingGames = new Set(rows.map((r) => r.gameId)).size;
  const estimate = intervals
    ? countContrastEvaluator(data, fitted.coefficients, lambda, alpha)
    : null;
  const factors = parks.map((parkId) => {
    const own = rows.filter((r) => r.parkId === parkId),
      games = new Set(own.map((r) => r.gameId)).size,
      teams = new Set(own.map((r) => r.teamId)),
      n = own.reduce((s, r) => s + exposure(r, metric), 0),
      contrast = columns.map((c) =>
        c.startsWith("park:") ? (c === `park:${parkId}` ? 1 : 0) - 1 / parks.length : 0,
      ),
      supported = withPark && identifiable && fitted.converged && games >= 30 && teams.size >= 4,
      interval = supported && intervals ? (estimate?.(contrast) ?? null) : null;
    return {
      parkId,
      games,
      exposure: n,
      index: interval?.index ?? null,
      low95: interval?.low95 ?? null,
      high95: interval?.high95 ?? null,
      status: !withPark
        ? ("not_adopted" as const)
        : !identifiable || !fitted.converged
          ? ("unidentified" as const)
          : !supported || (intervals && interval === null)
            ? ("insufficient_data" as const)
            : ("supported" as const),
    };
  });
  return {
    metric,
    family,
    lambda,
    alpha,
    withPark,
    columns,
    coefficients: fitted.coefficients,
    seasons,
    parks,
    teams,
    months,
    converged: fitted.converged,
    identifiable,
    trainingGames,
    trainingRows: data.length,
    dispersion: dispersion(data, fitted.coefficients, columns.length),
    factors,
  };
}
const deviance = (y: number, mu: number) =>
  2 * (y === 0 ? mu : y * Math.log(y / Math.max(mu, 1e-15)) - y + mu);
function evaluate(fit: ParkEnvironmentFit, input: readonly ParkEnvironmentRow[], season: number) {
  const encode = rowEncoder(fit),
    games = new Set<string>();
  let rows = 0,
    excluded = 0,
    sum = 0,
    absolute = 0,
    observed = 0,
    expected = 0,
    pearson = 0;
  for (const r of input) {
    if (r.season !== season) continue;
    const row = encode(r);
    if (row === null || !fit.converged) {
      excluded++;
      continue;
    }
    const mu = countMean(row, fit.coefficients);
    rows++;
    games.add(r.gameId);
    sum += deviance(row.y, mu);
    absolute += Math.abs(row.y - mu);
    observed += row.y;
    expected += mu;
    pearson += (row.y - mu) ** 2 / Math.max(mu, 1e-10);
  }
  return {
    season,
    games: games.size,
    rows,
    excluded,
    deviance: rows === 0 ? null : sum / rows,
    mae: rows === 0 ? null : absolute / rows,
    observed,
    expected,
    dispersion: rows === 0 ? null : pearson / rows,
  };
}
export function trainParkEnvironment(
  input: readonly ParkEnvironmentRow[],
  sourceHash: string,
  through = 2024,
): ParkEnvironmentModel {
  const rows = [...input]
      .filter((r) => r.season >= 2020 && r.season <= through + 1)
      .sort((a, b) =>
        a.gameId < b.gameId
          ? -1
          : a.gameId > b.gameId
            ? 1
            : a.side < b.side
              ? -1
              : a.side > b.side
                ? 1
                : 0,
      ),
    years = modelValidationSeasons(through);
  const metrics = (["home_runs", "runs"] as const).map((metric) => {
    const options = [
        { withPark: false, lambda: 1, family: "poisson" as const },
        ...(["poisson", "negative_binomial"] as const).flatMap((family) =>
          [0.1, 1, 10].map((lambda) => ({ withPark: true, lambda, family })),
        ),
      ],
      base = years.map((year) => fitParkModel(rows, metric, year - 1, false, 1, "poisson"));
    const validation = options.map((option) => {
      const games = new Map<string, { sum: number; samples: number }>();
      let converged = true;
      const evaluations = years.map((season, i) => {
        const model = fitParkModel(
            rows,
            metric,
            season - 1,
            option.withPark,
            option.lambda,
            option.family,
          ),
          baseline = base[i];
        converged = converged && model.converged && model.identifiable;
        if (baseline !== undefined) {
          const a = rowEncoder(model),
            b = rowEncoder(baseline);
          for (const r of rows) {
            if (r.season !== season) continue;
            const left = a(r),
              right = b(r);
            if (left === null || right === null) continue;
            const game = games.get(left.game) ?? { sum: 0, samples: 0 };
            game.sum +=
              deviance(left.y, countMean(left, model.coefficients)) -
              deviance(right.y, countMean(right, baseline.coefficients));
            game.samples++;
            games.set(left.game, game);
          }
        }
        return evaluate(model, rows, season);
      });
      return {
        ...option,
        converged,
        evaluations,
        devianceDifference95: option.withPark ? gameLossInterval([...games.values()]) : null,
      };
    });
    const candidates = validation.filter(
      (v) =>
        v.withPark &&
        v.converged &&
        v.evaluations.length === 2 &&
        v.devianceDifference95 !== null &&
        v.devianceDifference95.high < 0 &&
        v.evaluations.every(
          (e, i) =>
            e.deviance !== null &&
            e.deviance < (validation[0]?.evaluations[i]?.deviance ?? -Infinity),
        ),
    );
    candidates.sort(
      (a, b) =>
        a.evaluations.reduce((s, e) => s + (e.deviance ?? Infinity), 0) -
          b.evaluations.reduce((s, e) => s + (e.deviance ?? Infinity), 0) || a.lambda - b.lambda,
    );
    const choice = candidates[0],
      fitted = fitParkModel(
        rows,
        metric,
        through,
        choice !== undefined,
        choice?.lambda ?? 1,
        choice?.family ?? "poisson",
        true,
      ),
      adopted =
        choice !== undefined &&
        fitted.converged &&
        fitted.identifiable &&
        fitted.factors.some((f) => f.status === "supported"),
      evaluation = evaluate(fitted, rows, through + 1);
    return {
      metric,
      adopted,
      fitted: adopted
        ? fitted
        : {
            ...fitted,
            factors: fitted.factors.map((f) => ({
              ...f,
              index: null,
              low95: null,
              high95: null,
              status: "not_adopted" as const,
            })),
          },
      validation,
      evaluation: evaluation.rows + evaluation.excluded === 0 ? null : evaluation,
    };
  });
  return {
    version: 1,
    kind: "park-counts",
    sourceHash,
    trainedThrough: through,
    policy: "regular-normal-nine-complete-halves-1-to-8",
    metrics,
  };
}

import { useQuery } from "@tanstack/react-query";
import "../styles/pitch-analysis.css";
import { Link, useSearchParams } from "react-router-dom";
import { Value } from "@sinclair/typebox/value";
import {
  BattingStatisticsQuerySchema,
  PitchingStatisticsQuerySchema,
  type BattingStatisticsRow,
  type PitchingStatisticsRow,
} from "@kbo/contracts";
import { AnalysisScopeFields, scopeFromParams } from "../analysis/analysis-scope-fields";
import { getBattingStatistics, getPitchingStatistics } from "../api/player-statistics-client";
const number = (n: number | null, digits = 3) => (n === null ? "—" : n.toFixed(digits));
const percent = (n: number | null) => (n === null ? "—" : `${(n * 100).toFixed(1)}%`);
const innings = (outs: number) =>
  `${Math.floor(outs / 3)}${outs % 3 === 0 ? "" : outs % 3 === 1 ? "⅓" : "⅔"}`;

export function PlayerStatisticsPage() {
  const [params, setParams] = useSearchParams();
  const selected = new URLSearchParams(params);
  if (!selected.has("competition")) selected.set("competition", "regular");
  const season = Number(params.get("season") ?? 2025),
    scope = scopeFromParams(season, selected);
  const kind = params.get("kind") === "pitching" ? "pitching" : "batting";
  const common = {
    season,
    ...scope.options,
    group: params.get("group") ?? "player",
    page: Number(params.get("page") ?? 1),
    limit: 50,
  };
  const batting = {
    ...common,
    sort: params.get("sort") ?? "ops",
    minPA: Number(params.get("minimum") ?? 0),
  };
  const pitching = {
    ...common,
    sort: params.get("sort") ?? "kMinusBbRate",
    minBF: Number(params.get("minimum") ?? 0),
  };
  const validBatting = Value.Check(BattingStatisticsQuerySchema, batting),
    validPitching = Value.Check(PitchingStatisticsQuerySchema, pitching);
  const bat = useQuery({
    queryKey: ["statistics-batting", batting],
    enabled: kind === "batting" && validBatting && scope.error === null,
    queryFn: ({ signal }) => {
      if (!Value.Check(BattingStatisticsQuerySchema, batting)) throw new Error("잘못된 타격 조건");
      return getBattingStatistics(batting, signal);
    },
  });
  const pitch = useQuery({
    queryKey: ["statistics-pitching", pitching],
    enabled: kind === "pitching" && validPitching && scope.error === null,
    queryFn: ({ signal }) => {
      if (!Value.Check(PitchingStatisticsQuerySchema, pitching))
        throw new Error("잘못된 투구 조건");
      return getPitchingStatistics(pitching, signal);
    },
  });
  const active = kind === "batting" ? bat : pitch;
  const valid = scope.error === null && (kind === "batting" ? validBatting : validPitching);
  function change(key: string, value: string) {
    const next = new URLSearchParams(params);
    if (value === "") next.delete(key);
    else next.set(key, value);
    if (key !== "page") next.delete("page");
    if (key === "kind") {
      next.delete("sort");
      next.delete("minimum");
    }
    if (key === "season") {
      next.delete("dateFrom");
      next.delete("dateTo");
    }
    setParams(next);
  }
  const detail = (playerId: string) => {
    const query = new URLSearchParams(
      Object.entries({
        season,
        ...scope.options,
        [kind === "batting" ? "batter" : "pitcher"]: playerId,
      }).map(([k, v]) => [k, String(v)]),
    );
    return `/analysis/${kind === "batting" ? "batter-discipline" : "pitch-shape"}?${query}`;
  };
  return (
    <div className="page-stack">
      <header className="page-header">
        <div>
          <h1>선수·팀 성적</h1>
          <p>
            선택한 수집 경기의 현재 기록을 합산합니다. 이적 선수는 경기 당시 팀별로 나눠 표시합니다.
          </p>
        </div>
      </header>
      <section className="panel pitch-analysis-toolbar" aria-label="성적 조건">
        <label>
          시즌
          <select
            aria-label="성적 시즌"
            value={season}
            onChange={(e) => change("season", e.target.value)}
          >
            {[2020, 2021, 2022, 2023, 2024, 2025].map((y) => (
              <option key={y}>{y}</option>
            ))}
          </select>
        </label>
        <AnalysisScopeFields params={selected} onChange={change} />
        <label>
          성적 종류
          <select
            aria-label="성적 종류"
            value={kind}
            onChange={(e) => change("kind", e.target.value)}
          >
            <option value="batting">타격</option>
            <option value="pitching">투구</option>
          </select>
        </label>
        <label>
          집계
          <select
            aria-label="성적 집계"
            value={common.group}
            onChange={(e) => change("group", e.target.value)}
          >
            <option value="player">선수·당시 팀</option>
            <option value="team">팀</option>
          </select>
        </label>
        <label>
          최소 {kind === "batting" ? "타석" : "상대 타자"}
          <input
            aria-label="최소 표본"
            type="number"
            min="0"
            value={params.get("minimum") ?? "0"}
            onChange={(e) => change("minimum", e.target.value)}
          />
        </label>
        <label>
          정렬
          <select
            aria-label="성적 정렬"
            value={params.get("sort") ?? (kind === "batting" ? "ops" : "kMinusBbRate")}
            onChange={(e) => change("sort", e.target.value)}
          >
            {(kind === "batting"
              ? [
                  ["ops", "OPS"],
                  ["avg", "타율"],
                  ["plateAppearances", "타석"],
                  ["homeRuns", "홈런"],
                ]
              : [
                  ["kMinusBbRate", "K−BB%"],
                  ["era", "ERA"],
                  ["battersFaced", "상대 타자"],
                  ["outsRecorded", "이닝"],
                ]
            ).map(([key, label]) => (
              <option key={key} value={key}>
                {label}
              </option>
            ))}
          </select>
        </label>
      </section>
      {!valid && <p role="alert">{scope.error ?? "조회 조건이 올바르지 않습니다."}</p>}
      {valid && active.isPending && <p role="status">성적을 합산하고 있습니다.</p>}
      {active.error && <p role="alert">{active.error.message}</p>}
      {valid && active.data && (
        <section className="panel">
          <p>
            {active.data.total}개 행 · 최소 표본은 탐색 조건이며 공식 규정 충족을 뜻하지 않습니다.
          </p>
          {kind === "batting" && bat.data && <BattingTable rows={bat.data.rows} detail={detail} />}
          {kind === "pitching" && pitch.data && (
            <PitchingTable rows={pitch.data.rows} detail={detail} />
          )}
          {active.data.total === 0 && (
            <p>
              선택 범위의 자료가 없습니다.{" "}
              <Link to={`/analysis/coverage?season=${season}`}>경기 분류와 수집 범위 확인</Link>
            </p>
          )}
          <nav aria-label="성적 페이지">
            <button
              disabled={common.page <= 1}
              onClick={() => change("page", String(common.page - 1))}
            >
              이전
            </button>
            <span>{common.page}쪽</span>
            <button
              disabled={common.page * 50 >= active.data.total}
              onClick={() => change("page", String(common.page + 1))}
            >
              다음
            </button>
          </nav>
          <p>
            비율의 분모가 0이면 —입니다. 볼넷은 고의4구를 포함합니다. 미제공 자책점은 0으로 채우지
            않습니다.
          </p>
        </section>
      )}
    </div>
  );
}
function BattingTable({
  rows,
  detail,
}: {
  rows: BattingStatisticsRow[];
  detail: (id: string) => string;
}) {
  return (
    <div className="table-scroll" tabIndex={0}>
      <table aria-label="타격 성적">
        <thead>
          <tr>
            {[
              "선수/팀",
              "당시 팀",
              "경기",
              "PA",
              "AB",
              "H",
              "2B",
              "3B",
              "HR",
              "BB (IBB)",
              "HBP",
              "SO",
              "SF",
              "SH",
              "R",
              "TB",
              "AVG",
              "OBP",
              "SLG",
              "OPS",
              "K%",
              "BB%",
            ].map((h) => (
              <th key={h}>{h}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={JSON.stringify([r.identity, r.teamId])}>
              <th>
                {r.playerId === null ? r.name : <Link to={detail(r.playerId)}>{r.name}</Link>}
              </th>
              <td>{r.teamName}</td>
              {[
                r.games,
                r.plateAppearances,
                r.atBats,
                r.hits,
                r.doubles,
                r.triples,
                r.homeRuns,
                `${r.walks} (${r.intentionalWalks})`,
                r.hitByPitch,
                r.strikeouts,
                r.sacrificeFlies,
                r.sacrificeBunts,
                r.runs,
                r.totalBases,
                number(r.avg),
                number(r.obp),
                number(r.slg),
                number(r.ops),
                percent(r.kRate),
                percent(r.bbRate),
              ].map((x, i) => (
                <td key={i}>{x}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
function PitchingTable({
  rows,
  detail,
}: {
  rows: PitchingStatisticsRow[];
  detail: (id: string) => string;
}) {
  return (
    <>
      <p>
        자책점 미확인 경기가 있으면 전체 ERA는 —입니다. 확인 경기 ERA는 해당 경기의 아웃 수만 분모에
        넣습니다.
      </p>
      <div className="table-scroll" tabIndex={0}>
        <table aria-label="투구 성적">
          <thead>
            <tr>
              {[
                "선수/팀",
                "당시 팀",
                "경기",
                "BF",
                "이닝",
                "H",
                "R",
                "BB (IBB)",
                "HBP",
                "SO",
                "투구",
                "스트라이크",
                "K%",
                "BB%",
                "K−BB%",
                "ERA",
                "ER 확인 경기",
                "확인 이닝",
                "확인 ER",
                "확인 경기 ERA",
              ].map((h) => (
                <th key={h}>{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={JSON.stringify([r.identity, r.teamId])}>
                <th>
                  {r.playerId === null ? r.name : <Link to={detail(r.playerId)}>{r.name}</Link>}
                </th>
                <td>{r.teamName}</td>
                {[
                  r.games,
                  r.battersFaced,
                  innings(r.outsRecorded),
                  r.hits,
                  r.runs,
                  `${r.walks} (${r.intentionalWalks})`,
                  r.hitByPitch,
                  r.strikeouts,
                  r.pitches,
                  r.strikes,
                  percent(r.kRate),
                  percent(r.bbRate),
                  percent(r.kMinusBbRate),
                  number(r.era, 2),
                  `${r.knownErGames}/${r.games}`,
                  innings(r.knownErOuts),
                  r.knownErGames === 0 ? "—" : r.knownEarnedRuns,
                  number(r.knownGamesEra, 2),
                ].map((x, i) => (
                  <td key={i}>{x}</td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}

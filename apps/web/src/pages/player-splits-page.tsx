import { useQuery } from "@tanstack/react-query";
import { Value } from "@sinclair/typebox/value";
import {
  PlayerSplitDimensionSchema,
  PlayerSplitQuerySchema,
  playerSplitBuckets,
  type PlayerSplitBucket,
  type PlayerSplitResponse,
} from "@kbo/contracts";
import { analysisQueryMeta } from "../analysis/analysis-query-meta";
import { AnalysisQueryError } from "../analysis/analysis-query-error";
import { PlayerRecordTable } from "../analysis/player-record-table";
import { usePlayerRecordScope } from "../analysis/use-player-record-scope";
import { formatStatNumber } from "../analysis/statistics-format";
import { getPlayerSplits } from "../api/player-statistics-client";

function splitLabels(pitcher: boolean, scoring: boolean): Record<PlayerSplitBucket, string> {
  return {
    L: pitcher ? "좌타자 상대" : "좌완 상대",
    R: pitcher ? "우타자 상대" : "우완 상대",
    unknown: scoring ? "주자 상황 미확인" : "상대 손 미확인",
    home: "홈",
    away: "원정",
    risp: "득점권 주자 있음",
    "no-risp": "득점권 주자 없음",
  };
}

type SplitStats = Omit<PlayerSplitResponse["rows"][number], "bucket">;

function SplitTable({ data, byCount = false }: { data: PlayerSplitResponse; byCount?: boolean }) {
  const pitcher = data.query.role === "pitcher";
  const labels = splitLabels(pitcher, data.query.split === "risp");
  const chartRows = byCount
    ? (data.byCount ?? []).map((row) => ({
        heading:
          row.count === null ? "종결 카운트 미확인" : `${row.count.balls}-${row.count.strikes}`,
        row,
      }))
    : data.rows.map((row) => ({ heading: labels[row.bucket], row }));
  const columns = pitcher
    ? ["상황", "상대 타자", "피안타", "피홈런", "볼넷", "삼진", "피OPS"]
    : ["상황", "타석", "타수", "안타", "홈런", "타율", "출루율", "OPS"];
  return (
    <section className="player-season-records">
      <PlayerRecordTable
        label={
          byCount ? "선택 상황의 카운트별 성적" : pitcher ? "상황별 상대 성적" : "상황별 타격 성적"
        }
        columns={byCount ? ["종결 카운트", ...columns.slice(1)] : columns}
        rows={chartRows.map(({ heading, row }: { heading: string; row: SplitStats }) => ({
          id: heading,
          heading,
          values: pitcher
            ? [
                row.plateAppearances,
                row.hits,
                row.homeRuns,
                row.walks,
                row.strikeouts,
                formatStatNumber(row.ops),
              ]
            : [
                row.plateAppearances,
                row.atBats,
                row.hits,
                row.homeRuns,
                formatStatNumber(row.avg),
                formatStatNumber(row.obp),
                formatStatNumber(row.ops),
              ],
        }))}
      />
      {!byCount && data.query.split === "hand" && (
        <p className="analysis-caption">상대 손은 타석을 끝낸 상대의 확인된 기록을 사용합니다.</p>
      )}
      {!byCount && data.query.split === "risp" && (
        <p className="analysis-caption">
          타석 결과 직전에 2루나 3루에 주자가 있었는지 봅니다. 타석 도중 도루·폭투로 바뀐 주자
          상태를 반영합니다.
        </p>
      )}
    </section>
  );
}

export function PlayerSplitsPage() {
  const {
    params,
    season,
    scope,
    query: selection,
    loading,
    change,
    setParams,
  } = usePlayerRecordScope();
  const requestedSplit = params.get("split") ?? "hand";
  const split = Value.Check(PlayerSplitDimensionSchema, requestedSplit) ? requestedSplit : "hand";
  const bucket = (playerSplitBuckets[split] as readonly PlayerSplitBucket[]).find(
    (value) => value === params.get("countFor"),
  );
  const query = selection === null ? null : { ...selection, split };
  const detailQuery =
    query === null || bucket === undefined ? null : { ...query, countFor: bucket };
  const valid = Value.Check(PlayerSplitQuerySchema, query);
  const error =
    scope.error ?? (query !== null && !valid ? "선수 조회 조건이 올바르지 않습니다." : null);
  const records = useQuery({
    queryKey: ["player-split-records", query],
    meta: analysisQueryMeta(season),
    enabled: error === null && valid && !loading,
    queryFn: ({ signal }) => {
      if (!Value.Check(PlayerSplitQuerySchema, query)) throw new Error("잘못된 상황별 조회 조건");
      return getPlayerSplits(query, signal);
    },
  });
  const details = useQuery({
    queryKey: ["player-split-records", detailQuery],
    meta: analysisQueryMeta(season),
    enabled: error === null && detailQuery !== null && !loading,
    queryFn: ({ signal }) => {
      if (!Value.Check(PlayerSplitQuerySchema, detailQuery))
        throw new Error("잘못된 카운트별 조회 조건");
      return getPlayerSplits(detailQuery, signal);
    },
  });
  const data = details.data ?? records.data;
  const hasAppearances = data?.rows.some((row) => row.plateAppearances > 0);
  const labels = splitLabels(data?.query.role === "pitcher", split === "risp");
  return (
    <div className="page-stack">
      <header className="page-header player-season-heading">
        <h1>상황별 성적</h1>
      </header>
      <label className="player-basic-comparison-kind">
        비교 기준
        <select
          aria-label="비교 기준"
          value={split}
          onChange={(event) => {
            const next = new URLSearchParams(params);
            next.set("split", event.target.value);
            next.delete("countFor");
            setParams(next);
          }}
        >
          <option value="hand">상대 손</option>
          <option value="venue">홈·원정</option>
          <option value="risp">득점권</option>
        </select>
      </label>
      {error !== null && <p role="alert">{error}</p>}
      {error === null && query === null && <p role="status">상황별 기록을 볼 선수를 선택하세요.</p>}
      {error === null && (loading || records.isFetching) && (
        <p role="status">상황별 기록을 읽고 있습니다.</p>
      )}
      {error === null && <AnalysisQueryError queries={[records]} />}
      {data && !hasAppearances && <p role="status">선택한 범위에 완료 타석 기록이 없습니다.</p>}
      {data && hasAppearances && (
        <>
          <SplitTable data={data} />
          <section className="player-split-counts" aria-label="상황별 카운트 심화 분석">
            <label className="player-basic-comparison-kind">
              카운트별로 볼 상황
              <select
                aria-label="카운트별로 볼 상황"
                value={bucket ?? ""}
                onChange={(event) => change("countFor", event.target.value)}
              >
                <option value="">상황 선택</option>
                {data.rows
                  .filter((row) => row.plateAppearances > 0 || row.bucket === bucket)
                  .map((row) => (
                    <option key={row.bucket} value={row.bucket}>
                      {labels[row.bucket]}
                    </option>
                  ))}
              </select>
            </label>
            {details.isFetching && <p role="status">카운트별 성적을 읽고 있습니다.</p>}
            {bucket !== undefined && <AnalysisQueryError queries={[details]} />}
            {details.data?.byCount?.length === 0 && (
              <p role="status">이 상황의 완료 타석이 없습니다.</p>
            )}
            {details.data?.byCount && details.data.byCount.length > 0 && (
              <>
                <SplitTable data={details.data} byCount />
                <p className="analysis-caption">
                  완료 타석의 마지막 투구 직전 볼·스트라이크입니다. 해당 카운트가 없는 타석은
                  미확인에 포함합니다.
                </p>
              </>
            )}
          </section>
        </>
      )}
    </div>
  );
}

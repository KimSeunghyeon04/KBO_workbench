import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import type { MatchupQuery, MatchupModelResponse } from "@kbo/contracts";
import { getMatchupModel } from "../api/matchup-model-client";
const percent = (v: number | null) => (v === null ? "—" : `${(v * 100).toFixed(1)}%`);
const labels = { swing: "스윙", whiff: "헛스윙 / 스윙", called_strike: "루킹 / 비스윙" };
const locationLabels: Record<string, string> = {
  "left-outside": "왼쪽 존 밖",
  "right-outside": "오른쪽 존 밖",
  left: "왼쪽",
  right: "오른쪽",
  center: "가운데",
  below: "존 아래",
  above: "존 위",
  low: "낮음",
  middle: "중간",
  high: "높음",
};
export function MatchupModelPanel({ query }: { query: MatchupQuery }) {
  const [open, setOpen] = useState(false),
    result = useQuery({
      queryKey: ["matchup-model", query],
      queryFn: ({ signal }) => getMatchupModel(query, signal),
      enabled: open,
    });
  return (
    <section className="panel" aria-label="구질 유사도와 타자별 기대 반응">
      <button type="button" aria-expanded={open} onClick={() => setOpen(!open)}>
        구질 유사도·기대 반응 {open ? "접기" : "보기"}
      </button>
      {open && (
        <>
          {result.isPending && <p role="status">구질 표본과 검증된 모델을 확인하고 있습니다.</p>}
          {result.error && <p role="alert">{result.error.message}</p>}
          {result.data && <MatchupModelResult key={result.data.sourceHash} data={result.data} />}
        </>
      )}
    </section>
  );
}
function MatchupModelResult({ data }: { data: MatchupModelResponse }) {
  const [page, setPage] = useState(0),
    [groupPage, setGroupPage] = useState(0),
    similar = data.similarity;
  if (data.status !== "ready")
    return (
      <p>
        {data.status === "scope_mismatch"
          ? "이 분석은 확인된 정규시즌에서 제공합니다."
          : "현재 원천에 맞는 매치업 모델이 없습니다. 위의 직접 상대·조건 비교를 이용할 수 있습니다."}
      </p>
    );
  return (
    <>
      <p>
        학습 종료 {data.trainedThrough}년. 구속·보정된 수평/수직 구질·도착 시간의 거리를 같은
        구종·카운트·타석 좌우·5 km/h 구간 안에서 비교합니다. 거리와 기준은 학습 자료에 고정되며
        표본이 적어도 범위를 늘리지 않습니다.
      </p>
      <p>
        구질·코스 모델과 공통으로 사용할 수 있는 표본: 투수 {data.pitcherCoverage.used}/
        {data.pitcherCoverage.actual}구 · 타자 {data.batterCoverage.used}/
        {data.batterCoverage.actual}구. 궤적·코스/신장 누락, 보정 미지원과 학습 범위 밖 표본은
        제외합니다.
      </p>
      {similar && (
        <>
          <h3>구질이 비슷한 투구의 관측 반응</h3>
          <p>
            거리 기준 {similar.radius} · {similar.pitches}구 / {similar.games}경기 /{" "}
            {similar.pitchers}투수 · 한 투수의 최대 비중 {percent(similar.largestPitcherShare)}.
            직접 상대와 {similar.directOverlap}구가 겹치므로 합산하지 않습니다. 조건 일치{" "}
            {similar.conditionCandidates}구 중 거리로 {similar.excludedByDistance}구를 제외했습니다.
          </p>
          <p>
            {similar.validatedImprovement
              ? "과거 시즌의 스윙 예측 비교에서 거리 기준이 개선 조건을 통과했습니다."
              : "거리 기준의 예측 개선이 검증되지 않아 탐색용 관측 비교로 제공합니다."}{" "}
            각 비율은 분모 {similar.minSamples}개 이상에서 표시합니다.
          </p>
          <p>
            스윙 {percent(similar.swing.probability)} ({similar.swing.samples}구) · 헛스윙/스윙{" "}
            {percent(similar.whiff.probability)} ({similar.whiff.samples}스윙) · 루킹/비스윙{" "}
            {percent(similar.calledStrike.probability)} ({similar.calledStrike.samples}비스윙)
          </p>
          <details>
            <summary>유사 투구 근거</summary>
            <div className="table-scroll">
              <table aria-label="구질 유사 투구 근거">
                <thead>
                  <tr>
                    <th>경기</th>
                    <th>투수</th>
                    <th>구종</th>
                    <th>구속</th>
                    <th>거리</th>
                  </tr>
                </thead>
                <tbody>
                  {similar.rows.slice(page * 25, page * 25 + 25).map((r) => (
                    <tr key={JSON.stringify([r.gameId, r.revision, r.pitchId])}>
                      <td>
                        <Link
                          to={`/replay?${new URLSearchParams({ gameId: r.gameId, revision: String(r.revision) })}`}
                        >
                          {r.gameDate} · {r.pitchId}
                        </Link>
                      </td>
                      <td>{r.pitcherId}</td>
                      <td>{r.pitchType}</td>
                      <td>{r.speedKph}</td>
                      <td>{r.distance.toFixed(3)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <button disabled={page === 0} onClick={() => setPage(page - 1)}>
              이전 근거
            </button>
            <button
              disabled={(page + 1) * 25 >= similar.rows.length}
              onClick={() => setPage(page + 1)}
            >
              다음 근거
            </button>
          </details>
        </>
      )}
      <h3>선택 타자의 기대 반응</h3>
      <p>
        선택 기간 투수의 관측된 구질·카운트·정규화 코스 구성에 타자 효과를 적용합니다. 코스는 당시
        타자의 존으로 정규화한 상대 위치이며 선택 타자의 실제 도착 위치를 예측하지 않습니다. 타자의
        관측된 타석 좌우별로 구분하며, 투수 손잡이를 추정하지 않습니다. 최적 구종 추천이나 인과
        효과는 아닙니다.
      </p>
      {data.effects.map((e) => (
        <p key={e.target}>
          {labels[e.target]}:{" "}
          {e.status === "ready"
            ? "검증 통과"
            : e.status === "not_adopted"
              ? "검증 기준 미달로 확률 미제공"
              : "타자 이력 부족으로 확률 미제공"}{" "}
          · 훈련 {e.trainingSamples}개 / {e.trainingGames}경기
        </p>
      ))}
      <div className="table-scroll">
        <table aria-label="타자별 구종 코스 기대 반응">
          <thead>
            <tr>
              <th>구종</th>
              <th>타석</th>
              <th>정규화 코스</th>
              <th>투구</th>
              <th>스윙</th>
              <th>헛스윙/스윙</th>
              <th>루킹/비스윙</th>
              <th>헛스윙/투구</th>
            </tr>
          </thead>
          <tbody>
            {data.groups.slice(groupPage * 25, groupPage * 25 + 25).map((g) => (
              <tr key={JSON.stringify([g.pitchType, g.stance, g.location])}>
                <th>{g.pitchType}</th>
                <td>{g.stance}</td>
                <td>
                  {g.location
                    .split("/")
                    .map((v) => locationLabels[v] ?? v)
                    .join(" / ")}
                </td>
                <td>{g.pitches}</td>
                <td>{percent(g.swing)}</td>
                <td>{percent(g.whiff)}</td>
                <td>{percent(g.calledStrike)}</td>
                <td>{percent(g.whiffPerPitch)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <button disabled={groupPage === 0} onClick={() => setGroupPage(groupPage - 1)}>
        이전 코스
      </button>
      <button
        disabled={(groupPage + 1) * 25 >= data.groups.length}
        onClick={() => setGroupPage(groupPage + 1)}
      >
        다음 코스
      </button>
    </>
  );
}

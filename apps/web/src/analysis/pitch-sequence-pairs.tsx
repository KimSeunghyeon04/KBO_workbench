import { AnalysisEvidenceLink } from "./analysis-evidence-link";
import { useMemo, useRef, useState } from "react";
import { flushSync } from "react-dom";
import type { PitchSequenceResponse } from "@kbo/contracts";
import { pitchCallLabel } from "../events/relay-text";
import { replayEvidenceUrl } from "../replay/evidence-target";
import { SampleRate } from "./sample-rate";
import { PitchSequenceTrajectory } from "./pitch-sequence-trajectory";
import { PitchSequenceGroups } from "./pitch-sequence-groups";
import { PitchReleasePanel } from "./pitch-release-panel";
import "../styles/pitch-sequence-pairs.css";
const n = (v: number | null) => v?.toFixed(2) ?? "—";
const signed = (v: number | null) => (v !== null && v > 0 ? `+${n(v)}` : n(v));

function MeanCell({
  value,
  pairs,
  difference = false,
}: {
  value: number | null;
  pairs: number;
  difference?: boolean;
}) {
  return (
    <td>
      {difference ? signed(value) : n(value)} <br />
      <small>유효 {pairs}쌍</small>
    </td>
  );
}

export function PitchSequencePairs({ data }: { data: PitchSequenceResponse }) {
  const comparisonHeading = useRef<HTMLHeadingElement>(null);
  const [group, setGroup] = useState<string | null>(null),
    [page, setPage] = useState(0),
    [index, setIndex] = useState(0);
  const pairGroups = useMemo(() => {
    const groups = new Map<string, PitchSequenceResponse["pairs"]>();
    for (const pair of data.pairs) {
      const key = JSON.stringify([pair.previous.pitchType, pair.current.pitchType]);
      const existing = groups.get(key);
      if (existing) existing.push(pair);
      else groups.set(key, [pair]);
    }
    return groups;
  }, [data.pairs]);
  const pairs = group === null ? data.pairs : (pairGroups.get(group) ?? []);
  const selected = pairs[index];
  const labelFor = (key: string) => {
    const pair = pairGroups.get(key)?.[0];
    return `${pair?.previous.pitchType ?? "미상"} → ${pair?.current.pitchType ?? "미상"}`;
  };
  function selectGroup(key: string | null) {
    setGroup(key);
    setPage(0);
    setIndex(0);
  }
  function selectPair(nextIndex: number) {
    setIndex(nextIndex);
    setPage(Math.floor(nextIndex / 20));
  }
  return (
    <>
      <PitchSequenceGroups
        groups={data.groups}
        group={group}
        labelFor={labelFor}
        onSelect={selectGroup}
      />
      <section className="panel sequence-comparison" aria-label="선택한 두 공 비교">
        <h2>두 공의 궤적</h2>
        {selected ? (
          <>
            <div className="sequence-pair-navigation">
              <span>
                {pairs.length}쌍 중 {index + 1}번째
              </span>
              <button disabled={index === 0} onClick={() => selectPair(index - 1)}>
                이전 쌍
              </button>
              <button disabled={index + 1 >= pairs.length} onClick={() => selectPair(index + 1)}>
                다음 쌍
              </button>
            </div>
            <h3 ref={comparisonHeading} tabIndex={-1} className="analysis-comparison-target">
              {selected.current.gameDate} · {selected.current.stadium ?? "구장 미상"} ·{" "}
              {labelFor(JSON.stringify([selected.previous.pitchType, selected.current.pitchType]))}{" "}
              · 선택 목록 {index + 1}번째 쌍
            </h3>
            <PitchSequenceTrajectory selected={selected} />
            <PitchReleasePanel
              groups={data.releaseGroups}
              pitchTypes={[selected.previous.pitchType, selected.current.pitchType]}
            />
            <AnalysisEvidenceLink
              to={replayEvidenceUrl(selected.current.gameId, selected.current.revision, {
                kind: "event",
                id: selected.current.pitchId,
              })}
            >
              선택한 두 번째 공 재생 r{selected.current.revision}
            </AnalysisEvidenceLink>
          </>
        ) : (
          <p>선택 조건에 맞는 연속 투구가 없습니다. 배합 조건을 넓혀 주세요.</p>
        )}
      </section>
      <details className="panel sequence-group-details">
        <summary>조합별 상세 성적과 계산 기준</summary>
        <p>
          성과는 두 번째 공의 결과를 집계합니다. Swing%는 스윙/쌍, Whiff%는 헛스윙/스윙, 루킹%는
          루킹/쌍입니다. 쌍 수는 조건을 만족한 두 번째 실제 투구 수입니다.
        </p>
        <p className="analysis-caption">
          기하 쌍은 두 공 모두 y=23.8ft 비교면의 위치를 계산할 수 있는 쌍입니다. 평균마다 계산
          가능한 유효 쌍만 사용하며, 유효 0쌍은 —로 표시합니다.
        </p>
        <p className="analysis-caption">
          시간·구속 차는 두 번째−첫 번째입니다. 시간의 +는 50피트부터 비교면까지 더 오래 걸렸다는
          뜻입니다. 구속의 +는 더 빠른 공을 뜻합니다.
        </p>
        <div className="table-scroll" tabIndex={0}>
          <table className="analysis-sticky-table" aria-label="두 구종 조합">
            <thead>
              <tr>
                {[
                  "조합",
                  "쌍",
                  "스윙",
                  "헛스윙",
                  "Swing%",
                  "Whiff%",
                  "루킹%",
                  "기하 쌍",
                  "평균 면 간격 cm",
                  "평균 도달 시간차 ms",
                  "평균 구속 차 km/h",
                  "평균 도착 코스 차 cm",
                ].map((s) => (
                  <th key={s} scope="col">
                    {s}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {data.groups.map((g) => {
                return (
                  <tr key={g.key}>
                    <th scope="row">
                      <button
                        aria-pressed={group === g.key}
                        onClick={() => {
                          flushSync(() => selectGroup(g.key));
                          comparisonHeading.current?.focus({ preventScroll: true });
                          comparisonHeading.current?.scrollIntoView?.({ block: "start" });
                        }}
                      >
                        {labelFor(g.key)}
                      </button>
                    </th>
                    <td>{g.pairs}</td>
                    <td>{g.swings}</td>
                    <td>{g.whiffs}</td>
                    <td>
                      <SampleRate
                        value={g.swingRate}
                        numerator={g.swings}
                        denominator={g.pairs}
                        unit="쌍"
                      />
                    </td>
                    <td>
                      <SampleRate
                        value={g.whiffRate}
                        numerator={g.whiffs}
                        denominator={g.swings}
                        unit="스윙"
                      />
                    </td>
                    <td>
                      <SampleRate value={g.calledStrikeRate} denominator={g.pairs} unit="쌍" />
                    </td>
                    <td>{g.geometryPairs}</td>
                    <MeanCell value={g.meanPlaneDistanceCm} pairs={g.planeDistancePairs} />
                    <MeanCell
                      value={g.meanPlaneTimeDifferenceMs}
                      pairs={g.planeTimeDifferencePairs}
                      difference
                    />
                    <MeanCell
                      value={g.meanSpeedDifferenceKph}
                      pairs={g.speedDifferencePairs}
                      difference
                    />
                    <MeanCell value={g.meanArrivalDistanceCm} pairs={g.arrivalDistancePairs} />
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </details>
      <section className="panel">
        <h2>선택 조합의 투구 근거</h2>
        <p>{pairs.length}쌍</p>
        <div className="table-scroll" tabIndex={0}>
          <table aria-label="배합 투구 근거">
            <thead>
              <tr>
                {[
                  "날짜",
                  "첫 공 → 두 번째 공",
                  "첫 결과",
                  "두 번째 카운트",
                  "두 번째 결과",
                  "비교",
                  "경기",
                ].map((s) => (
                  <th key={s}>{s}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {pairs.slice(page * 20, page * 20 + 20).map((p, i) => (
                <tr
                  key={JSON.stringify([p.current.gameId, p.current.revision, p.current.pitchId])}
                  className={index === page * 20 + i ? "analysis-selected-row" : undefined}
                >
                  <td>{p.current.gameDate}</td>
                  <td>
                    {p.previous.pitchType ?? "미상"} → {p.current.pitchType ?? "미상"}
                    <details className="analysis-evidence-id">
                      <summary>투구 ID</summary>
                      {p.previous.pitchId} → {p.current.pitchId}
                    </details>
                  </td>
                  <td>{pitchCallLabel(p.previous.pitchCall)}</td>
                  <td>
                    {p.current.balls}-{p.current.strikes}
                  </td>
                  <td>{pitchCallLabel(p.current.pitchCall)}</td>
                  <td>
                    <button
                      aria-pressed={index === page * 20 + i}
                      onClick={() => {
                        flushSync(() => setIndex(page * 20 + i));
                        comparisonHeading.current?.focus({ preventScroll: true });
                        comparisonHeading.current?.scrollIntoView?.({ block: "start" });
                      }}
                    >
                      궤적 비교
                    </button>
                  </td>
                  <td>
                    <AnalysisEvidenceLink
                      to={replayEvidenceUrl(p.current.gameId, p.current.revision, {
                        kind: "event",
                        id: p.current.pitchId,
                      })}
                    >
                      재생 r{p.current.revision}
                    </AnalysisEvidenceLink>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <button disabled={page === 0} onClick={() => setPage(page - 1)}>
          이전
        </button>
        <button disabled={(page + 1) * 20 >= pairs.length} onClick={() => setPage(page + 1)}>
          다음
        </button>
      </section>
    </>
  );
}

import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import type {
  AnalysisScopeQuery,
  WorkloadComparisonResponse,
  WorkloadComparisonDimension,
} from "@kbo/contracts";
import { getWorkloadComparison } from "../api/workload-comparison-client";

const dimensions: { key: WorkloadComparisonDimension; label: string }[] = [
  { key: "pitchNumber", label: "경기 내 투구 수" },
  { key: "rest", label: "관측 휴식일" },
  { key: "previous3Days", label: "이전 3일 투구 수" },
  { key: "previous7Days", label: "이전 7일 투구 수" },
  { key: "meeting", label: "같은 타자 대면 회차" },
];
const metrics = [
  { key: "speed", label: "평균 구속 (km/h)" },
  { key: "swing", label: "스윙률 (%)" },
  { key: "whiff", label: "헛스윙률 / 스윙 (%)" },
] as const;
function groupLabel(dimension: WorkloadComparisonDimension, group: string) {
  if (dimension === "rest") return `${group === "2+" ? "2일 이상" : `${group}일`} 휴식`;
  if (dimension === "meeting") return group === "3" ? "3회 이상" : `${group}회`;
  return `${group}구`;
}
export function WorkloadComparisonPanel({
  query,
  pitcherId,
}: {
  query: AnalysisScopeQuery;
  pitcherId: string;
}) {
  const [open, setOpen] = useState(false),
    result = useQuery({
      queryKey: ["workload-comparison", pitcherId, query],
      queryFn: ({ signal }) => getWorkloadComparison(query, pitcherId, signal),
      enabled: open && pitcherId !== "",
    });
  return (
    <section className="panel" aria-label="조건을 맞춘 투수 운용 비교">
      <button type="button" aria-expanded={open} onClick={() => setOpen(!open)}>
        조건을 맞춘 운용 비교 {open ? "접기" : "보기"}
      </button>
      {open && (
        <>
          <p>
            같은 투수·시즌에서 등판 역할, 구종, 타석 좌우, 볼·스트라이크가 같은 조건끼리 비교합니다.
            두 집단에 공통인 조건을 같은 비중으로 맞춥니다.
          </p>
          <p>
            구속은 구속 확인 투구, 스윙률은 실제 투구, 헛스윙률은 스윙이 분모입니다. 차이는 비교
            집단 − 기준 집단이며, 95% 구간은 경기 단위로 계산합니다.
          </p>
          <p>
            수집 누락과 시기·구장·실제 코스·상대 타자 차이는 남습니다. 피로나 교체의 인과 효과를
            뜻하지 않습니다. 순서가 미상인 같은 날 복수 등판과 직전 등판 미상은 휴식·최근 투구량
            비교에서 제외합니다.
          </p>
          {result.isFetching && (
            <p role="status">운용 조건과 경기별 불확실성을 계산하고 있습니다.</p>
          )}
          <p>
            역할은 등록 선발/구원을 우선 사용합니다. 등록 정보가 없으면 첫 실제 투구 투수·후속
            투수라는 관측 구분을 따로 사용하며, 공식 선발/구원으로 간주하지 않습니다.
          </p>
          {result.error && <p role="alert">{result.error.message}</p>}
          {result.data && (
            <ComparisonResult key={`${pitcherId}-${result.data.sourceHash}`} data={result.data} />
          )}
        </>
      )}
    </section>
  );
}
function ComparisonResult({ data }: { data: WorkloadComparisonResponse }) {
  const [dimension, setDimension] = useState<WorkloadComparisonDimension>("pitchNumber"),
    [metric, setMetric] = useState<(typeof metrics)[number]["key"]>("speed"),
    selected = data.dimensions.find((d) => d.dimension === dimension),
    number = (value: number | null) =>
      value === null ? "—" : (value * (metric === "speed" ? 1 : 100)).toFixed(2);
  return (
    <>
      <div className="toolbar">
        <label>
          비교 항목{" "}
          <select
            aria-label="운용 비교 항목"
            value={dimension}
            onChange={(e) => {
              const value = dimensions.find((d) => d.key === e.target.value);
              if (value) setDimension(value.key);
            }}
          >
            {dimensions.map((d) => (
              <option key={d.key} value={d.key}>
                {d.label}
              </option>
            ))}
          </select>
        </label>
        <label>
          성과{" "}
          <select
            aria-label="운용 비교 성과"
            value={metric}
            onChange={(e) => {
              const value = metrics.find((m) => m.key === e.target.value);
              if (value) setMetric(value.key);
            }}
          >
            {metrics.map((m) => (
              <option key={m.key} value={m.key}>
                {m.label}
              </option>
            ))}
          </select>
        </label>
      </div>
      <p>
        실제 {data.actualPitches.toLocaleString()}구 · 비교 조건 미상{" "}
        {data.excludedConditionPitches.toLocaleString()}구 · 운용 조건 미상{" "}
        {selected?.excludedWorkloadPitches.toLocaleString()}구 · 분류 가능{" "}
        {selected?.groupedPitches.toLocaleString()}구.
      </p>
      <p>
        각 조건·집단에 분모 {data.policy.minCellSamples}개 이상, 공통 조건을 합쳐 집단마다{" "}
        {data.policy.minGroupSamples}개·{data.policy.minGroupGames}경기 이상일 때 비교합니다. 아래
        분모는 선택한 성과 기준입니다.
      </p>
      <div className="table-scroll" tabIndex={0}>
        <p>
          등판 역할 근거: 등록 정보 {data.roleEvidence.registeredPitches.toLocaleString()}구 ·
          첫/후속 투수 관측 {data.roleEvidence.observedPitches.toLocaleString()}구 · 미상{" "}
          {data.roleEvidence.unknownPitches.toLocaleString()}구.
        </p>
        <table aria-label="조건을 맞춘 운용 성과">
          <thead>
            <tr>
              {[
                "기준 → 비교",
                "원 집계 기준 → 비교",
                "조건 맞춤 기준 → 비교",
                `차이 (${metric === "speed" ? "km/h" : "%p"})`,
                "차이의 95% 구간",
                "공통 분모 / 전체 분모 (기준 · 비교)",
                "공통 경기 (기준 · 비교)",
                "공통 조건",
                "상태",
              ].map((label) => (
                <th key={label}>{label}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {selected?.comparisons
              .filter((r) => r.metric === metric)
              .map((r) => (
                <tr key={r.comparison}>
                  <th>
                    {groupLabel(dimension, r.reference)} → {groupLabel(dimension, r.comparison)}
                  </th>
                  <td>
                    {number(r.baseline.rawMean)} → {number(r.target.rawMean)}
                  </td>
                  <td>
                    {number(r.baseline.adjustedMean)} → {number(r.target.adjustedMean)}
                  </td>
                  <td>{number(r.difference)}</td>
                  <td>
                    {r.interval === null
                      ? "—"
                      : `${number(r.interval.low)} ~ ${number(r.interval.high)}`}
                  </td>
                  <td>
                    {r.baseline.matchedSamples} / {r.baseline.samples} · {r.target.matchedSamples} /{" "}
                    {r.target.samples}
                  </td>
                  <td>
                    {r.baseline.matchedGames} · {r.target.matchedGames}
                  </td>
                  <td>{r.commonStrata}</td>
                  <td>
                    {r.status === "ready"
                      ? "비교 가능"
                      : r.status === "unstable_interval"
                        ? "경기 재표집 불안정"
                        : "공통 표본 부족"}
                  </td>
                </tr>
              ))}
          </tbody>
        </table>
      </div>
      <p>
        원 집계도 비교 조건을 확인할 수 있는 투구만 포함합니다. 조건 맞춤 값은 공통 조건의 표본이
        적은 집단 수를 가중치로 사용합니다. 각 표의 구간은 개별 비교용이며 여러 비교의 동시 유의성을
        보장하지 않습니다.
      </p>
    </>
  );
}

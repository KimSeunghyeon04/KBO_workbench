import type { MatchupResponse } from "@kbo/contracts";
import { SampleRate } from "./sample-rate";
import "../styles/matchup-observed-summary.css";

type Cohort = MatchupResponse["direct"];
const metrics = [
  {
    label: "스윙 / 투구",
    rate: "swingRate",
    numerator: "swings",
    denominator: "pitches",
    unit: "구",
  },
  {
    label: "헛스윙 / 스윙",
    rate: "whiffRate",
    numerator: "whiffs",
    denominator: "swings",
    unit: "스윙",
  },
  {
    label: "루킹 스트라이크 / 투구",
    rate: "calledStrikeRate",
    numerator: "calledStrikes",
    denominator: "pitches",
    unit: "구",
  },
] as const;

export function MatchupObservedSummary({ direct, similar }: { direct: Cohort; similar: Cohort }) {
  const cohorts = [
    { key: "direct", label: "직접 상대", value: direct },
    { key: "similar", label: "유사 조건", value: similar },
  ];
  return (
    <section className="matchup-observed-summary" aria-label="매치업 반응 비교">
      <h2>직접 맞대결과 비슷한 조건의 반응</h2>
      <p>
        유사 조건은 같은 원 구종·카운트·타석 좌우·5 km/h 구간입니다. 두 표본은 겹칠 수 있어 합산하지
        않습니다.
      </p>
      <dl className="matchup-cohorts">
        {cohorts.map((cohort) => (
          <div key={cohort.key}>
            <dt>{cohort.label}</dt>
            <dd>
              <strong>{cohort.value.pitches.toLocaleString()}구</strong> · {cohort.value.games}경기
              · {cohort.value.pitchers}투수
            </dd>
          </div>
        ))}
      </dl>
      <p className="analysis-caption">공통 눈금 0–100% · 관측 비율이며 예상 확률이 아닙니다.</p>
      <div className="matchup-rate-groups">
        {metrics.map((metric) => (
          <section key={metric.rate} aria-label={metric.label}>
            <h3>{metric.label}</h3>
            {cohorts.map((cohort) => (
              <div className="matchup-rate-row" key={cohort.key}>
                <span>{cohort.label}</span>
                <span className={`matchup-rate-track ${cohort.key}`} aria-hidden="true">
                  {cohort.value[metric.rate] !== null && cohort.value[metric.denominator] > 0 && (
                    <i style={{ width: `${(cohort.value[metric.rate] ?? 0) * 100}%` }} />
                  )}
                </span>
                <SampleRate
                  value={cohort.value[metric.rate]}
                  numerator={cohort.value[metric.numerator]}
                  denominator={cohort.value[metric.denominator]}
                  unit={metric.unit}
                />
              </div>
            ))}
          </section>
        ))}
      </div>
    </section>
  );
}

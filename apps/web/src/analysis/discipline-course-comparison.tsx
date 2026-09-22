import type { DisciplineResponse } from "@kbo/contracts";
import { percent, signedNumber, transitionLabels } from "./discipline-panels";

const difference = (v: number | null) => (v === null ? "—" : `${signedNumber(v * 100)}%p`);

export function DisciplineCourseComparison({ data }: { data: DisciplineResponse }) {
  const { conventional, common, paired } = data.courseComparison;
  const cohorts = [
    { label: "기존 코스 · 타자", rates: conventional.batter },
    { label: "기존 코스 · 리그", rates: conventional.league },
    { label: "포심 비교 가능 · 타자", rates: common.batter },
    { label: "포심 비교 가능 · 리그", rates: common.league },
  ];
  const outside = common.batter;
  const breakdown = [
    {
      key: "outside",
      pitches: outside.outsidePitches,
      swings: outside.outsideSwings,
      swingRate: outside.chaseRate,
    },
    ...data.transitions.filter((g) => g.key === "in-out" || g.key === "out-out"),
  ];
  const labels: Record<string, string> = { ...transitionLabels, outside: "실제 존 밖 전체" };
  return (
    <section
      className="panel discipline-panel discipline-course-comparison"
      aria-label="기존 코스와 포심 가정 비교"
    >
      <span className="pitch-analysis-eyebrow">비교 기준 · 실제 코스 Chase%</span>
      <h2>기존 코스 분석에 포심 가정을 더하면</h2>
      <p className="discipline-caption">
        Chase%는 실제 존 밖 공 중 스윙한 비율입니다. 기존 코스는 실제 위치로 존 판정이 가능한 공을,
        포심 비교 가능 표본은 그중 포심 가정도 계산할 수 있는 공을 사용합니다. 번트·고의사구 등의
        제외 기준과 선택 필터는 같습니다. 리그는 선택 타자를 제외합니다.
      </p>
      <div className="discipline-table-scroll">
        <table className="discipline-table">
          <caption>기존 코스 기본 지표 · 조건 보정 전</caption>
          <thead>
            <tr>
              <th scope="col">표본</th>
              <th scope="col">존 판정 가능</th>
              <th scope="col">Zone%</th>
              <th scope="col">Swing%</th>
              <th scope="col">Z-Swing%</th>
              <th scope="col">Chase%</th>
              <th scope="col">존 밖 스윙 / 공</th>
            </tr>
          </thead>
          <tbody>
            {cohorts.map(({ label, rates: r }) => (
              <tr key={label}>
                <th scope="row">{label}</th>
                <td>{r.pitches.toLocaleString()}구</td>
                <td>{percent(r.zoneRate)}</td>
                <td>{percent(r.swingRate)}</td>
                <td>{percent(r.zoneSwingRate)}</td>
                <td>
                  <strong>{percent(r.chaseRate)}</strong>
                </td>
                <td>
                  {r.outsideSwings.toLocaleString()} / {r.outsidePitches.toLocaleString()}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="discipline-caption">
        Zone%: 받은 공 중 존 안 비율 · Swing%: 전체 스윙 비율 · Z-Swing%: 존 안 공의 스윙 비율. 위
        표의 모든 지표는 존 판정이 가능한 공을 기준으로 합니다. 리그 값은 단순 합산이므로, 조건을
        맞춘 비교는 아래 표를 사용합니다.
      </p>
      <div className="discipline-table-scroll">
        <table className="discipline-table">
          <caption>같은 존 밖 공을 포심 가정으로 나눈 결과</caption>
          <thead>
            <tr>
              <th scope="col">포심 가정 → 실제</th>
              <th scope="col">스윙 / 공</th>
              <th scope="col">스윙률</th>
            </tr>
          </thead>
          <tbody>
            {breakdown.map((g) => (
              <tr key={g.key}>
                <th scope="row">{labels[g.key] ?? g.key}</th>
                <td>
                  {g.swings.toLocaleString()} / {g.pitches.toLocaleString()}
                </td>
                <td>{percent(g.swingRate)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="discipline-caption">
        ‘존 안 → 존 밖’과 ‘존 밖 → 존 밖’의 스윙 수와 투구 수를 합하면 전체 Chase%가 됩니다. 포심
        가정은 같은 공을 나누는 기준이며, 전체 Chase%를 바꾸지 않습니다.
      </p>
      <div className="discipline-table-scroll">
        <table className="discipline-table">
          <caption>동일 표본의 리그 비교 · 포심 조건 추가 전후</caption>
          <thead>
            <tr>
              <th scope="col">구간</th>
              <th scope="col">공통 비교 표본</th>
              <th scope="col">타자</th>
              <th scope="col">리그 · 코스 기준</th>
              <th scope="col">리그 · 포심 추가</th>
              <th scope="col">
                타자 − 리그
                <br />
                코스 / 포심 추가
              </th>
            </tr>
          </thead>
          <tbody>
            {paired.map((g) => (
              <tr key={g.key}>
                <th scope="row">{labels[g.key]}</th>
                <td>
                  {g.matchedSwings} / {g.matchedPitches}구
                </td>
                <td>{percent(g.matchedSwingRate)}</td>
                <td>{percent(g.courseLeagueSwingRate)}</td>
                <td>{percent(g.expectationLeagueSwingRate)}</td>
                <td>
                  {difference(g.courseDifference)} / {difference(g.expectationDifference)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="discipline-caption">
        두 비교값 모두 같은 타자 투구와 포심 비교 가능한 다른 타자 집단을 사용합니다. 코스 기준은
        카운트·중계 구종·타석·구속대·실제 코스를 맞추고, 포심 추가는 예상 존 안팎도 맞춥니다. 양쪽
        모두 다른 타자 20구 이상인 조건만 남깁니다. 공통 비교 표본은 스윙 수 / 투구 수입니다.
        비교값의 변화는 예측 정확도 향상이나 선구안 점수를 뜻하지 않습니다.
      </p>
    </section>
  );
}

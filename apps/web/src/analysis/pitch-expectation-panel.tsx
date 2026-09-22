import type {
  PitchAnalysisResponse,
  PitchExpectationGroup,
  PitchReferenceBand,
} from "@kbo/contracts";
import { signed } from "./pitch-shape-chart";
import type { ColorMode } from "./pitch-presentation";

export const referenceBandLabel = (band: PitchReferenceBand | null): string =>
  band === "core50"
    ? "포심 중앙 50% 안"
    : band === "shell90"
      ? "포심 50~90% 영역"
      : band === "outside90"
        ? "포심 90% 영역 밖"
        : "포심 분포 비교 불가";
const rate = (value: number | null) => (value === null ? "—" : `${(value * 100).toFixed(1)}%`);
const meanSpread = (mean: number | null, sd: number | null) =>
  mean === null || sd === null ? "—" : `${signed(mean)} ± ${sd.toFixed(1)}`;

export function PitchExpectationPanel({
  data,
  colorMode,
  filter,
}: {
  readonly data: PitchAnalysisResponse;
  readonly colorMode: ColorMode;
  readonly filter: string;
}): React.JSX.Element {
  const groups = (
    colorMode === "provider"
      ? data.expectation.providerGroups.map((g) => ({ ...g, label: g.pitchType ?? "구종 미상" }))
      : data.expectation.clusterGroups.map((g) => ({
          ...g,
          label: g.clusterId === null ? "미배정" : `클러스터 ${g.clusterId}`,
        }))
  )
    .filter((g) => filter === "" || g.label === filter)
    .sort((a, b) => b.count - a.count || a.label.localeCompare(b.label));
  const whiffs = (group: PitchExpectationGroup) => (
    <>
      <strong>{rate(group.whiffRate)}</strong>
      <small>
        {group.whiffs.toLocaleString()} / {group.swings.toLocaleString()} 스윙
      </small>
    </>
  );
  return (
    <section className="panel pitch-expectation" aria-label="포심 기대와의 차이">
      <header>
        <h2>포심을 기다린 타자와의 차이</h2>
        <p>
          시즌 평균 포심의 위치·타이밍을 예상했다는 가정입니다. 50피트 출발 위치와 방향을 정렬한
          모델에서 비교합니다.
        </p>
      </header>
      <div
        className="pitch-expectation-table"
        tabIndex={0}
        role="region"
        aria-label="구종별 기대 차이 표"
      >
        <table>
          <caption>
            {colorMode === "provider" ? "중계 구종" : "클러스터"}별 비교 · 위치·시간은 평균 ±
            표준편차
          </caption>
          <thead>
            <tr>
              <th scope="col">{colorMode === "provider" ? "구종" : "클러스터"}</th>
              <th scope="col">투구 수</th>
              <th scope="col">좌우 (cm)</th>
              <th scope="col">높이 (cm)</th>
              <th scope="col">도착 시간차 (ms)</th>
              <th scope="col">포심 90% 밖</th>
              <th scope="col">헛스윙률</th>
            </tr>
          </thead>
          <tbody>
            {groups.map((g) => (
              <tr key={g.label}>
                <th scope="row">{g.label}</th>
                <td>{g.count.toLocaleString()}</td>
                <td>{meanSpread(g.meanXCm, g.sdXCm)}</td>
                <td>{meanSpread(g.meanZCm, g.sdZCm)}</td>
                <td>{meanSpread(g.meanTimingMs, g.sdTimingMs)}</td>
                <td>
                  {rate(
                    g.outside90Count === null || g.count === 0 ? null : g.outside90Count / g.count,
                  )}
                  {g.outside90Count !== null && (
                    <small>
                      {g.outside90Count.toLocaleString()} / {g.count.toLocaleString()}구
                    </small>
                  )}
                </td>
                <td>{whiffs(g)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="pitch-expectation-note">
        높이 +는 예상보다 위, 시간차 +는 늦게 도착합니다. 헛스윙률 = 헛스윙 / 스윙이며 스윙이 없으면
        —로 표시합니다.
      </p>
      {data.referenceDistribution !== null && (
        <>
          <h3>포심 분포에서 벗어난 정도와 헛스윙</h3>
          <p className="pitch-expectation-note">
            선택한 투수·시즌의 전체 유효 투구 기준입니다. 구종·군집 필터와 무관하게 비교합니다.
          </p>
          <div className="pitch-expectation-bands">
            {data.expectation.bands.map((g) => (
              <div key={g.band}>
                <span>{referenceBandLabel(g.band)}</span>
                <b>{g.count.toLocaleString()}구</b>
                {whiffs(g)}
              </div>
            ))}
          </div>
          <p className="pitch-expectation-note">
            시즌 포심 {data.referenceDistribution.sampleCount.toLocaleString()}구에서 실제 포함률은
            안쪽{" "}
            {(
              (data.referenceDistribution.central50.includedCount /
                data.referenceDistribution.sampleCount) *
              100
            ).toFixed(1)}
            %, 바깥{" "}
            {(
              (data.referenceDistribution.central90.includedCount /
                data.referenceDistribution.sampleCount) *
              100
            ).toFixed(1)}
            %입니다. 경계에 같은 값이 있으면 목표 비율을 넘을 수 있습니다.
          </p>
        </>
      )}
      <p className="pitch-expectation-note">
        산점도에 포함된 투구의 관측 결과입니다. 코스·카운트·타자 좌우를 보정하지 않았으며, 실제
        포심을 노렸는지나 배트가 빗나간 거리를 측정한 값은 아닙니다.
      </p>
    </section>
  );
}

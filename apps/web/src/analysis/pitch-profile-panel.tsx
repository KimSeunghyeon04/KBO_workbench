import type { PitchProfile } from "@kbo/contracts";
const n = (x: number | null) => (x === null ? "—" : x.toFixed(1));
export function PitchProfilePanel({ profile }: { profile: PitchProfile }) {
  return (
    <section className="panel">
      <h2>구종 구성과 월별 변화</h2>
      <p>
        사용률은 실제 투구 전체, 구속은 유효 구속, 위치·시간은 계산 가능한 궤적을 분모로 사용합니다.
        위치의 ± 값은 표본 표준편차입니다.
      </p>
      <div className="table-scroll" tabIndex={0}>
        <table aria-label="구종 프로필">
          <thead>
            <tr>
              <th>기간</th>
              <th>구종</th>
              <th>실제 투구</th>
              <th>사용률</th>
              <th>구속 km/h · 표본</th>
              <th>궤적 · 보정</th>
              <th>가로 cm</th>
              <th>세로 cm</th>
              <th>도착 ms</th>
              <th>보정 표본 가로/세로/도착</th>
              <th>헛스윙/스윙</th>
            </tr>
          </thead>
          <tbody>
            {[{ month: "선택 기간", groups: profile.groups }, ...profile.months].flatMap((period) =>
              period.groups.map((g) => (
                <tr key={JSON.stringify([period.month, g.pitchType])}>
                  <th>{period.month}</th>
                  <th>{g.pitchType ?? "구종 미상"}</th>
                  <td>{g.actualPitches}</td>
                  <td>{g.usageRate === null ? "—" : `${(100 * g.usageRate).toFixed(1)}%`}</td>
                  <td>
                    {n(g.meanSpeedKph)} · {g.speedCount}
                  </td>
                  <td>
                    {g.shapeCount} · {g.calibratedCount}
                  </td>
                  <td>
                    {n(g.meanXCm)} ± {n(g.sdXCm)}
                  </td>
                  <td>
                    {n(g.meanZCm)} ± {n(g.sdZCm)}
                  </td>
                  <td>{n(g.meanArrivalMs)}</td>
                  <td>
                    {n(g.calibratedXCm)} / {n(g.calibratedZCm)} / {n(g.calibratedArrivalMs)}
                  </td>
                  <td>
                    {g.whiffs}/{g.swings}
                  </td>
                </tr>
              )),
            )}
          </tbody>
        </table>
      </div>
      <p>
        기간마다 보정 표본 비율을 함께 비교하세요. 시즌 상대 좌표의 차이에는 각 시즌 포심 기준의
        차이가 포함됩니다.
      </p>
    </section>
  );
}

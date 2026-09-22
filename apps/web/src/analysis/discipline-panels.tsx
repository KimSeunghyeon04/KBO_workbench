import type { DisciplineGroup, DisciplinePoint, DisciplineResponse } from "@kbo/contracts";

export const percent = (value: number | null): string =>
  value === null ? "—" : `${(value * 100).toFixed(1)}%`;
export const signedNumber = (value: number | null): string =>
  value === null ? "—" : `${value > 0 ? "+" : ""}${value.toFixed(1)}`;
export const transitionLabels: Record<string, string> = {
  "in-in": "존 안 → 존 안",
  "in-out": "존 안 → 존 밖",
  "out-in": "존 밖 → 존 안",
  "out-out": "존 밖 → 존 밖",
};
export const deviationLabels = [
  "−40 미만",
  "−40 ~ −20",
  "−20 ~ 0",
  "0 ~ +20",
  "+20 ~ +40",
  "+40 이상",
];
export function ComparisonTable({
  groups,
  labels,
  caption,
}: {
  groups: DisciplineGroup[];
  labels: Record<string, string>;
  caption: string;
}) {
  return (
    <div className="discipline-table-scroll">
      <table className="discipline-table">
        <caption>{caption}</caption>
        <thead>
          <tr>
            <th>구간</th>
            <th>스윙 / 공</th>
            <th>스윙률</th>
            <th>비교 가능</th>
            <th>타자 / 리그</th>
            <th>차이</th>
          </tr>
        </thead>
        <tbody>
          {groups.map((g) => (
            <tr key={g.key}>
              <th scope="row">{labels[g.key] ?? g.key}</th>
              <td>
                {g.swings} / {g.pitches}
              </td>
              <td>{percent(g.swingRate)}</td>
              <td>{g.matchedPitches}구</td>
              <td>
                {percent(g.matchedSwingRate)} / {percent(g.leagueSwingRate)}
              </td>
              <td>{g.difference === null ? "—" : `${signedNumber(g.difference * 100)}%p`}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function SwingMap({
  cells,
  selected,
  onSelect,
  difference,
}: {
  cells: DisciplineResponse["cells"];
  selected: number | null;
  onSelect: (cell: number | null) => void;
  difference: boolean;
}) {
  return (
    <>
      <div className="discipline-map" aria-label="코스별 스윙 지도">
        {[4, 3, 2, 1, 0].flatMap((z) =>
          [0, 1, 2, 3, 4].map((x) => {
            const cell = z * 5 + x;
            const g = cells.find((item) => item.key === String(cell));
            const value = difference ? (g?.difference ?? null) : (g?.swingRate ?? null);
            const inside = x > 0 && x < 4 && z > 0 && z < 4;
            const color =
              value === null
                ? "#f2f4f3"
                : difference
                  ? value < 0
                    ? `rgba(42,114,174,${0.12 + Math.min(0.6, Math.abs(value) * 2)})`
                    : `rgba(222,121,47,${0.12 + Math.min(0.6, Math.abs(value) * 2)})`
                  : `rgba(30,131,100,${0.05 + value * 0.65})`;
            return (
              <button
                key={cell}
                type="button"
                className={inside ? "in-zone" : "out-zone"}
                aria-label={`코스 ${cell + 1}: 스윙 ${g?.swings ?? 0} / ${g?.pitches ?? 0}구`}
                aria-pressed={selected === cell}
                style={{ background: color }}
                onClick={() => onSelect(selected === cell ? null : cell)}
              >
                <strong>
                  {value === null
                    ? "—"
                    : difference
                      ? `${signedNumber(value * 100)}p`
                      : percent(value)}
                </strong>
                <small>
                  {g?.swings ?? 0} / {g?.pitches ?? 0}구
                </small>
              </button>
            );
          }),
        )}
        <div className="discipline-zone-outline" aria-hidden="true" />
      </div>
      <p className="discipline-caption">
        원천 X 좌우 · 위쪽이 높은 공 · 굵은 선 안이 존<br />
        바깥 칸은 더 멀리 벗어난 공도 포함합니다. 칸을 누르면 아래 투구 목록을 좁힙니다.
      </p>
    </>
  );
}

export function DeviationBars({ groups, unit }: { groups: DisciplineGroup[]; unit: string }) {
  return (
    <div className="discipline-bars" aria-label="편차별 스윙률 그래프">
      {groups.map((g, i) => (
        <div key={g.key} className="discipline-bar-row">
          <span>
            {deviationLabels[i]} <small>{unit}</small>
          </span>
          <div className="discipline-bar-track">
            <i style={{ width: `${(g.swingRate ?? 0) * 100}%` }} />
          </div>
          <strong>
            {percent(g.swingRate)}
            <small>
              {g.swings} / {g.pitches}구
            </small>
          </strong>
        </div>
      ))}
      <p className="discipline-caption">
        막대는 선택 타자의 전체 표본 스윙률입니다. 조건을 맞춘 리그 비교는 아래 표의 ‘타자 / 리그’에
        표시합니다.
      </p>
    </div>
  );
}

export function SelectedDisciplinePitch({ point }: { point: DisciplinePoint }) {
  return (
    <div className="discipline-selected" aria-label="선택한 투구 상세" aria-live="polite">
      <strong>
        {point.gameDate} · {point.pitchType ?? "구종 미상"} · {point.balls}B {point.strikes}S
      </strong>
      <p>
        {point.swing ? (point.whiff ? "스윙 · 헛스윙" : "스윙 · 접촉") : "참음"} · 실제{" "}
        {point.inZone ? "존 안" : "존 밖"}
      </p>
      <dl>
        <div>
          <dt>실제 좌우 / 높이</dt>
          <dd>
            {signedNumber(point.xCm)} / {signedNumber(point.zCm)} cm
          </dd>
        </div>
        <div>
          <dt>포심 가정 좌우 / 높이</dt>
          <dd>
            {signedNumber(point.expectedXCm)} / {signedNumber(point.expectedZCm)} cm
          </dd>
        </div>
        <div>
          <dt>실제 − 포심 위치 차이</dt>
          <dd>
            {signedNumber(point.deltaXCm)} / {signedNumber(point.deltaZCm)} cm
          </dd>
        </div>
        <div>
          <dt>도착 시간 차이</dt>
          <dd>{signedNumber(point.deltaMs)} ms</dd>
        </div>
      </dl>
      <small>
        {point.gameId} · revision {point.revision} · {point.pitchId}
      </small>
    </div>
  );
}

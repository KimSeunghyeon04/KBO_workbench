import type { PitchReleaseGroup } from "@kbo/contracts";

type PairTypes = readonly [string | null, string | null];

export function PitchReleasePanel({
  groups,
  pitchTypes,
}: {
  groups: readonly PitchReleaseGroup[];
  pitchTypes?: PairTypes;
}) {
  const rows = pitchTypes
    ? pitchTypes.map((pitchType, i) => ({
        label: `${i === 0 ? "첫 공" : "두 번째 공"} · ${pitchType ?? "구종 미상"}`,
        group: groups.find((item) => item.pitchType === pitchType),
      }))
    : groups.map((group) => ({ label: group.pitchType, group }));
  const Heading = pitchTypes ? "h3" : "h2";
  return (
    <section className={pitchTypes ? "sequence-release" : "panel"} aria-label="시즌 릴리스 추정">
      <Heading>시즌 구종별 릴리스·익스텐션</Heading>
      {rows.length === 0 ? (
        <p className="analysis-caption">구종이 확인된 트래킹 표본이 없습니다.</p>
      ) : (
        <div className="table-scroll" tabIndex={0}>
          <table
            className="analysis-sticky-table"
            aria-label="시즌 구종별 릴리스와 익스텐션 추정치"
          >
            <thead>
              <tr>
                <th scope="col">구종</th>
                <th scope="col">릴리스 좌우 (cm)</th>
                <th scope="col">릴리스 높이 (cm)</th>
                <th scope="col">익스텐션 (cm)</th>
                <th scope="col">시즌 표본</th>
              </tr>
            </thead>
            <tbody>
              {rows.map(({ label, group }) => (
                <ReleaseRow key={label} label={label} group={group} />
              ))}
            </tbody>
          </table>
        </div>
      )}
      <p className="analysis-caption">시즌 전체 PTS 추정치 · — 추정 불가</p>
    </section>
  );
}

function ReleaseRow({ label, group }: { label: string; group: PitchReleaseGroup | undefined }) {
  const estimate = group?.estimate;
  return (
    <tr>
      <th scope="row">{label}</th>
      <td>{estimate ? String(Math.round(estimate.xCm)) : "—"}</td>
      <td>{estimate?.heightCm.toFixed(0) ?? "—"}</td>
      <td>{estimate?.extensionCm.toFixed(0) ?? "—"}</td>
      <td>
        {group ? `${group.pitches.toLocaleString()}구 · ${group.games.toLocaleString()}경기` : "—"}
      </td>
    </tr>
  );
}

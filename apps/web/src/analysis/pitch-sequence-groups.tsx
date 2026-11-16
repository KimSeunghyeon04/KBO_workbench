import type { PitchSequenceResponse } from "@kbo/contracts";

export function PitchSequenceGroups({
  groups,
  group,
  labelFor,
  onSelect,
}: {
  groups: PitchSequenceResponse["groups"];
  group: string | null;
  labelFor: (key: string) => string;
  onSelect: (key: string | null) => void;
}) {
  const ranked = [...groups].sort(
    (a, b) => b.pairs - a.pairs || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0),
  );
  const maximum = ranked[0]?.pairs ?? 0;
  return (
    <section className="panel sequence-groups" aria-label="구종 조합 선택">
      <div className="sequence-group-header">
        <div>
          <h2>연속해서 던진 구종</h2>
          <p>첫 공 → 두 번째 공. 조합을 선택하면 아래에서 실제 두 공을 비교합니다.</p>
        </div>
        <label>
          비교할 조합
          <select value={group ?? ""} onChange={(event) => onSelect(event.target.value || null)}>
            <option value="">전체 조합</option>
            {ranked.map((row) => (
              <option key={row.key} value={row.key}>
                {labelFor(row.key)} · {row.pairs}쌍
              </option>
            ))}
          </select>
        </label>
      </div>
      <p className="analysis-caption">
        {groups.length > 6
          ? `전체 ${groups.length}개 중 투구 수 상위 6개 조합`
          : `전체 ${groups.length}개 조합`}{" "}
        · 막대는 공통 0 기준의 연속 투구 쌍 수입니다.
      </p>
      <div className="sequence-frequency">
        {ranked.slice(0, 6).map((row) => (
          <button key={row.key} aria-pressed={group === row.key} onClick={() => onSelect(row.key)}>
            <span>{labelFor(row.key)}</span>
            <span className="sequence-frequency-track" aria-hidden="true">
              <span style={{ width: `${maximum === 0 ? 0 : (row.pairs / maximum) * 100}%` }} />
            </span>
            <strong>{row.pairs.toLocaleString()}쌍</strong>
          </button>
        ))}
      </div>
    </section>
  );
}

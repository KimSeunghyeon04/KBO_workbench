import { useState } from "react";
import {
  compareCanonicalStrings,
  type PitchCountFlowGroup,
  type PitchCountOutcome,
} from "@kbo/contracts";
import { outcomePercent } from "./pitch-outcome-presentation";
import {
  countFlowSample,
  countText,
  pitchCounts,
  PitchCountTree,
  type PitchSelection,
  type PitchType,
} from "./pitch-count-tree";
import "../styles/pitch-arsenal.css";

const providerColors = new Map([
  ["직구", "#a34d43"],
  ["슬라이더", "#986323"],
  ["체인지업", "#246a54"],
  ["커브", "#367d82"],
  ["커터", "#426c9e"],
  ["투심", "#80548c"],
]);
const spareColors = ["#68713a", "#a56776", "#3a7397", "#84674b", "#505495"];
const unclassifiedColor = "#68746e";
const sideLabels = { all: "전체 타자", L: "좌타자 상대", R: "우타자 상대" } as const;
type Side = keyof typeof sideLabels;
type Drill = Pick<PitchCountFlowGroup, "balls" | "strikes" | "stance">;

function legendColors(groups: readonly PitchCountFlowGroup[]) {
  const types = [...new Set(groups.flatMap((group) => group.types.map((type) => type.pitchType)))];
  types.sort((a, b) =>
    a === b ? 0 : a === null ? 1 : b === null ? -1 : compareCanonicalStrings(a, b),
  );
  const colors = new Map<PitchType, string>();
  let next = 0;
  for (const type of types) {
    const known = type === null ? unclassifiedColor : providerColors.get(type);
    colors.set(type, known ?? spareColors[next++] ?? unclassifiedColor);
  }
  return colors;
}

export function PitchArsenalPanel({
  groups,
  onSelect,
}: {
  groups: readonly PitchCountFlowGroup[];
  onSelect: (count: Drill, pitch: string) => void;
}) {
  const [mode, setMode] = useState<"all" | "split">("split");
  const [inspected, setInspected] = useState(0);
  const [filter, setFilter] = useState<PitchSelection>();
  const sides: Side[] = mode === "all" ? ["all"] : ["L", "R"];
  const colors = legendColors(groups);
  const selectedPitch = filter !== undefined && colors.has(filter) ? filter : undefined;
  const countsBySide: Record<Side, Map<number, PitchCountFlowGroup>> = {
    all: new Map(),
    L: new Map(),
    R: new Map(),
  };
  for (const group of groups)
    countsBySide[group.stance].set(group.strikes * 4 + group.balls, group);
  const count = pitchCounts[inspected];
  if (count === undefined) return null;
  const samples = sides.map((stance) => ({
    stance,
    sample: countFlowSample(countsBySide[stance].get(count.key), selectedPitch),
  }));
  const detailRows: { kind: PitchCountOutcome; label: string }[] = [
    count.balls === 3
      ? { kind: "walk", label: "볼넷" }
      : { kind: "ball", label: `${count.balls + 1}–${count.strikes} 이동` },
    count.strikes === 2
      ? { kind: "strikeout", label: "삼진" }
      : { kind: "strike", label: `${count.balls}–${count.strikes + 1} 이동` },
    ...(count.strikes === 2
      ? [{ kind: "foul", label: `${countText(count)} 유지 · 일반 파울` } as const]
      : []),
    { kind: "inPlay", label: "인플레이" },
    { kind: "hitByPitch", label: "몸에 맞는 공" },
    { kind: "unresolved", label: "전이 미확인" },
  ];
  return (
    <section className="panel outcome-arsenal" aria-labelledby="outcome-arsenal-heading">
      <h2 id="outcome-arsenal-heading">카운트별 구종과 전이</h2>
      <div className="pitch-flow-toolbar">
        <div className="analysis-segments" role="group" aria-label="타자 구분">
          <button type="button" aria-pressed={mode === "all"} onClick={() => setMode("all")}>
            전체
          </button>
          <button type="button" aria-pressed={mode === "split"} onClick={() => setMode("split")}>
            좌·우 비교
          </button>
        </div>
        {selectedPitch !== undefined && (
          <button type="button" className="secondary-button" onClick={() => setFilter(undefined)}>
            전체 구종으로
          </button>
        )}
      </div>
      <p className="analysis-caption" aria-live="polite">
        모든 화살표 · {selectedPitch === undefined ? "전체 구종" : (selectedPitch ?? "구종 미상")} ·
        — 해당 조건의 투구 없음
      </p>
      {groups.length === 0 ? (
        <p role="status">선택한 범위에 실제 투구가 없습니다.</p>
      ) : (
        <>
          {mode === "split" && countsBySide.L.size === 0 && countsBySide.R.size === 0 && (
            <p role="status">
              좌·우 방향이 확인된 기록이 없습니다. 전체 보기에서 확인할 수 있습니다.
            </p>
          )}
          <div className={`pitch-flow-charts${mode === "split" ? " pitch-flow-split" : ""}`}>
            {sides.map((stance) => (
              <PitchCountTree
                key={stance}
                label={sideLabels[stance]}
                groups={countsBySide[stance]}
                colors={colors}
                selectedPitch={selectedPitch}
                onInspect={setInspected}
                onPitch={(key, pitch) => {
                  setInspected(key);
                  setFilter(pitch);
                }}
              />
            ))}
          </div>
          <ul className="pitch-flow-legend" aria-label="구종과 경로 범례">
            {[...colors].map(([pitch, color]) => (
              <li
                key={JSON.stringify(pitch)}
                className={pitch === selectedPitch ? "pitch-flow-highlight" : undefined}
              >
                <i style={{ background: color }} aria-hidden="true" />
                {pitch ?? "구종 미상"}
              </li>
            ))}
            {(
              [
                ["ball", "볼"],
                ["strike", "스트라이크"],
                ["foul", "2S 파울"],
              ] as const
            ).map(([kind, label]) => (
              <li key={kind} className={`pitch-flow-${kind}`}>
                <i className="pitch-flow-key-line" aria-hidden="true" />
                {label}
              </li>
            ))}
          </ul>
          <div className="pitch-flow-details">
            <div className="pitch-flow-toolbar">
              <h3>
                {countText(count)} ·{" "}
                {selectedPitch === undefined ? "전체 구종" : (selectedPitch ?? "구종 미상")} 한 공
                뒤
              </h3>
              <label>
                상세 카운트{" "}
                <select
                  value={inspected}
                  onChange={(event) => setInspected(Number(event.target.value))}
                >
                  {pitchCounts.map((option) => (
                    <option key={option.key} value={option.key}>
                      {countText(option)}
                    </option>
                  ))}
                </select>
              </label>
            </div>
            <table aria-label="선택 카운트의 한 공 뒤 결과">
              <thead>
                <tr>
                  <th scope="col">다음 상태</th>
                  {samples.map(({ stance, sample }) => (
                    <th key={stance} scope="col">
                      {sideLabels[stance]}
                      {sample !== undefined && <small>{sample.pitches.toLocaleString()}구</small>}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {detailRows.map(({ kind, label }) => (
                  <tr key={kind}>
                    <th scope="row">{label}</th>
                    {samples.map(({ stance, sample }) => {
                      const result = sample?.transitions.find((row) => row.outcome === kind);
                      return <td key={stance}>{outcomePercent(result?.rate ?? null)}</td>;
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
            {typeof selectedPitch === "string" && (
              <div className="pitch-flow-toolbar pitch-flow-evidence">
                {samples
                  .filter(({ sample }) => sample !== undefined)
                  .map(({ stance }) => (
                    <button
                      key={stance}
                      type="button"
                      className="secondary-button"
                      onClick={() =>
                        onSelect(
                          { balls: count.balls, strikes: count.strikes, stance },
                          selectedPitch,
                        )
                      }
                    >
                      {sideLabels[stance]} 코스 보기
                    </button>
                  ))}
              </div>
            )}
          </div>
        </>
      )}
      <p className="analysis-caption">
        원은 카운트별 전체 구종 구성입니다. 원을 확대해 구종을 고르면 모든 화살표가 그 구종의 관측
        전이율로 바뀝니다. 전체에는 양타석과 방향 미확인 기록도 포함합니다. 인플레이·사구·미확인은
        상세 표에서 봅니다.
      </p>
    </section>
  );
}

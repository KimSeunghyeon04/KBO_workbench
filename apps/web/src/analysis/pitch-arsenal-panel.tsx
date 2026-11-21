import { useState } from "react";
import type { PitchArsenalGroup } from "@kbo/contracts";
import { outcomePercent } from "./pitch-outcome-presentation";
import "../styles/pitch-arsenal.css";

const palette = ["#246a54", "#426c9e", "#986323", "#80548c", "#a34d43", "#367d82", "#68713a"];
const providerColors = new Map([
  ["직구", "#a34d43"],
  ["슬라이더", "#986323"],
  ["체인지업", "#246a54"],
  ["커브", "#367d82"],
  ["커터", "#426c9e"],
  ["투심", "#80548c"],
]);
const counts = Array.from({ length: 12 }, (_, index) => ({
  balls: index % 4,
  strikes: Math.floor(index / 4),
  key: index,
}));
const compareType = (a: string | null, b: string | null) =>
  a === b ? 0 : a === null ? 1 : b === null ? -1 : a < b ? -1 : 1;
function colorMap(types: readonly (string | null)[]) {
  const result = new Map<string | null, string>();
  for (const type of types)
    if (type !== null && providerColors.has(type))
      result.set(type, providerColors.get(type) ?? "#68746e");
  for (const type of types) {
    if (type === null) {
      result.set(type, "#68746e");
      continue;
    }
    if (result.has(type)) continue;
    result.set(type, palette.find((color) => ![...result.values()].includes(color)) ?? "#68746e");
  }
  return result;
}
function rankedTypes(group: PitchArsenalGroup) {
  return [...group.types].sort(
    (a, b) => b.usageRate - a.usageRate || compareType(a.pitchType, b.pitchType),
  );
}
function leading(group: PitchArsenalGroup | undefined) {
  if (group === undefined) return "기록 없음";
  const ranked = rankedTypes(group),
    first = ranked[0];
  if (first === undefined) return "기록 없음";
  const tied = ranked.filter((type) => type.usageRate === first.usageRate);
  return `${tied.map((type) => type.pitchType ?? "구종 미상").join("·")} ${outcomePercent(first.usageRate)}${tied.length > 1 ? " (공동 최다)" : ""}`;
}
const stanceLabel = (stance: string | null) =>
  stance === "L"
    ? "좌타자"
    : stance === "R"
      ? "우타자"
      : stance === "S"
        ? "양타석 표기"
        : stance === null
          ? "타석 방향 미확인"
          : `기타 표기 (${stance})`;
type Select = (group: PitchArsenalGroup, pitchType: string | null) => void;

export function PitchArsenalPanel({
  groups,
  onSelect,
}: {
  groups: readonly PitchArsenalGroup[];
  onSelect: Select;
}) {
  const [selected, setSelected] = useState(0);
  const known = groups.filter((group) => group.stance === "L" || group.stance === "R");
  const other = groups.filter((group) => group.stance !== "L" && group.stance !== "R");
  const available = counts.filter((count) =>
    known.some((group) => group.balls === count.balls && group.strikes === count.strikes),
  );
  const active = available.find((count) => count.key === selected) ?? available[0];
  const types = [
    ...new Set(groups.flatMap((group) => group.types.map((type) => type.pitchType))),
  ].sort(compareType);
  const colors = colorMap(types);
  const groupAt = (stance: string, balls: number, strikes: number) =>
    known.find(
      (group) => group.stance === stance && group.balls === balls && group.strikes === strikes,
    );
  return (
    <section className="panel outcome-arsenal" aria-labelledby="outcome-arsenal-heading">
      <h2 id="outcome-arsenal-heading">카운트 × 좌우 타자별 구종 배합</h2>
      <p className="analysis-caption">
        카운트 하나를 선택해 좌·우타자에게 어떤 구종을 골랐는지 비교하세요. 현재 조회 조건의 실제
        투구 기준이며, 비중의 분모는 해당 방향·카운트의 투구 수입니다.
      </p>
      {groups.length === 0 ? (
        <p role="status">선택한 조건에 구종 배합을 표시할 실제 투구가 없습니다.</p>
      ) : (
        <>
          <ul className="arsenal-legend" aria-label="구종 색상">
            {types.map((type) => (
              <li key={JSON.stringify(type)}>
                <i style={{ background: colors.get(type) }} aria-hidden="true" />
                {type ?? "구종 미상"}
              </li>
            ))}
          </ul>
          {active !== undefined ? (
            <>
              <div className="arsenal-board-heading">
                <h3>볼카운트 상태</h3>
                <p>열은 볼 · 행은 스트라이크</p>
              </div>
              <div className="arsenal-state-grid" role="group" aria-label="볼카운트 상태 선택">
                <span className="arsenal-axis-corner" aria-hidden="true">
                  S / B
                </span>
                {[0, 1, 2, 3].map((balls) => (
                  <span className="arsenal-ball-axis" key={`b${balls}`}>
                    {balls}볼
                  </span>
                ))}
                {[0, 1, 2].map((strikes) => (
                  <div className="arsenal-state-row" key={strikes}>
                    <span className="arsenal-strike-axis">{strikes}S</span>
                    {counts
                      .filter((count) => count.strikes === strikes)
                      .map((count) => {
                        const left = groupAt("L", count.balls, count.strikes),
                          right = groupAt("R", count.balls, count.strikes);
                        return (
                          <button
                            key={count.key}
                            type="button"
                            className="arsenal-state-node"
                            disabled={left === undefined && right === undefined}
                            aria-pressed={active.key === count.key}
                            aria-label={`${count.balls}볼 ${count.strikes}스트라이크 배합 선택 · 좌타자 ${left?.pitches ?? 0}구 ${leading(left)} · 우타자 ${right?.pitches ?? 0}구 ${leading(right)}`}
                            onClick={() => setSelected(count.key)}
                          >
                            <span className="arsenal-state-code">
                              {count.balls}–{count.strikes}
                            </span>
                            {([left, right] as const).map((group, index) => {
                              const first = group === undefined ? undefined : rankedTypes(group)[0];
                              const tied =
                                group !== undefined &&
                                group.types.filter((type) => type.usageRate === first?.usageRate)
                                  .length > 1;
                              return (
                                <span className="arsenal-state-choice" key={index}>
                                  <small>{index === 0 ? "좌" : "우"}</small>
                                  <span className="arsenal-state-type">
                                    {first === undefined ? (
                                      "—"
                                    ) : (
                                      <>
                                        <i
                                          aria-hidden="true"
                                          style={{ background: colors.get(first.pitchType) }}
                                        />
                                        {tied ? "공동 최다" : (first.pitchType ?? "구종 미상")}
                                      </>
                                    )}
                                  </span>
                                  <b>
                                    {first === undefined ? "—" : outcomePercent(first.usageRate)}
                                  </b>
                                </span>
                              );
                            })}
                            <span className="arsenal-state-sample">
                              <span>좌 {left?.pitches ?? 0}구</span>
                              <span className="arsenal-sample-divider" aria-hidden="true">
                                ·
                              </span>
                              <span>우 {right?.pitches ?? 0}구</span>
                            </span>
                          </button>
                        );
                      })}
                  </div>
                ))}
              </div>
              <p className="arsenal-state-note">
                각 상태의 최다 사용 구종을 표시합니다. 상태별 구종 선택 비중이며, 다음 카운트로의
                전이 확률은 계산하지 않습니다.
              </p>
              <div className="arsenal-selected-heading">
                <h3 aria-live="polite">
                  <strong>
                    {active.balls}–{active.strikes}
                  </strong>{" "}
                  카운트의 구종 선택
                </h3>
                <p>구종을 누르면 같은 조건의 코스로 이동합니다.</p>
              </div>
              <div className="arsenal-selected-sides">
                {(["L", "R"] as const).map((stance) => (
                  <ArsenalSide
                    key={stance}
                    stance={stance}
                    group={groupAt(stance, active.balls, active.strikes)}
                    colors={colors}
                    onSelect={onSelect}
                  />
                ))}
              </div>
            </>
          ) : (
            <p role="status">
              좌·우타석 방향이 확인된 투구가 없습니다. 별도 기록에서 원천 표기를 확인하세요.
            </p>
          )}
          {other.length > 0 && (
            <details className="arsenal-unclassified">
              <summary>
                좌·우로 분류하지 않은 기록 <span>타석 방향 미확인·양타석 등</span>
              </summary>
              <p>
                트래킹에 방향이 없으면 같은 경기의 선수 프로필에 명시된 좌타·우타로 보완합니다.
                ‘타석 방향 미확인’은 이 근거로도 방향을 확인할 수 없는 투구입니다. 프로필이 충돌하면
                미확인으로 남기며, 양타석 표기(S)는 실제 좌·우에 나누지 않습니다.
              </p>
              <div className="table-scroll" tabIndex={0}>
                <table aria-label="좌우 미분류 구종 배합">
                  <thead>
                    <tr>
                      <th>타석 방향</th>
                      <th>카운트 B–S</th>
                      <th>구종</th>
                      <th>투구</th>
                      <th>구성비</th>
                    </tr>
                  </thead>
                  <tbody>
                    {other.flatMap((group) =>
                      rankedTypes(group).map((type) => (
                        <tr
                          key={JSON.stringify([
                            group.stance,
                            group.balls,
                            group.strikes,
                            type.pitchType,
                          ])}
                        >
                          <th scope="row">{stanceLabel(group.stance)}</th>
                          <td>
                            {group.balls}–{group.strikes}
                          </td>
                          <td>
                            {group.stance === "S" && type.pitchType !== null ? (
                              <button
                                type="button"
                                className="secondary-button"
                                onClick={() => onSelect(group, type.pitchType)}
                              >
                                {type.pitchType} 코스 보기
                              </button>
                            ) : (
                              (type.pitchType ?? "구종 미상")
                            )}
                          </td>
                          <td>
                            {type.pitches}/{group.pitches}구
                          </td>
                          <td>{outcomePercent(type.usageRate)}</td>
                        </tr>
                      )),
                    )}
                  </tbody>
                </table>
              </div>
            </details>
          )}
        </>
      )}
    </section>
  );
}

function ArsenalSide({
  stance,
  group,
  colors,
  onSelect,
}: {
  stance: "L" | "R";
  group: PitchArsenalGroup | undefined;
  colors: ReadonlyMap<string | null, string>;
  onSelect: Select;
}) {
  const label = stanceLabel(stance);
  return (
    <section className="arsenal-side" aria-label={`${label} 선택 카운트 구종 배합`}>
      <header>
        <h4>{label}</h4>
        <span>{group === undefined ? "투구 없음" : `${group.pitches.toLocaleString()}구`}</span>
      </header>
      {group === undefined ? (
        <p className="analysis-caption">이 방향·카운트에서 관측된 투구가 없습니다.</p>
      ) : (
        <>
          <p className="arsenal-leading">
            최다 선택 <strong>{leading(group)}</strong>
          </p>
          {group.pitches < 20 && <p className="analysis-caption">소표본 · 해당 카운트 20구 미만</p>}
          <ul className="arsenal-pitch-choices">
            {rankedTypes(group).map((type) => (
              <li key={JSON.stringify(type.pitchType)}>
                <button
                  type="button"
                  disabled={type.pitchType === null}
                  aria-label={`${label} ${group.balls}볼 ${group.strikes}스트라이크 ${type.pitchType ?? "구종 미상"} 코스 보기`}
                  onClick={() => onSelect(group, type.pitchType)}
                >
                  <span className="arsenal-pitch-name">
                    <i aria-hidden="true" style={{ background: colors.get(type.pitchType) }} />
                    {type.pitchType ?? "구종 미상"}
                  </span>
                  <span className="arsenal-pitch-track" aria-hidden="true">
                    <span
                      style={{
                        width: `${type.usageRate * 100}%`,
                        background: colors.get(type.pitchType),
                      }}
                    />
                  </span>
                  <strong>{outcomePercent(type.usageRate)}</strong>
                  <small>
                    {type.pitches}/{group.pitches}구
                  </small>
                </button>
              </li>
            ))}
          </ul>
        </>
      )}
    </section>
  );
}

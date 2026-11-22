import { Fragment, useState } from "react";
import {
  pitchCountTerminalOutcomes,
  type PitchCountFlowGroup,
  type PitchCountOutcome,
  type PitchCountTerminalOutcome,
} from "@kbo/contracts";
import { outcomePercent } from "./pitch-outcome-presentation";

type Summary = Pick<PitchCountFlowGroup, "pitches" | "transitions" | "terminalDetails">;
type TerminalParent = keyof typeof pitchCountTerminalOutcomes;
const terminalLabels: Record<PitchCountTerminalOutcome, string> = {
  lookingStrikeout: "루킹 삼진",
  swingingStrikeout: "헛스윙 삼진",
  otherStrikeout: "기타 삼진",
  single: "단타",
  double: "2루타",
  triple: "3루타",
  homeRun: "홈런",
  battedOut: "타구 아웃",
  sacrifice: "희생타",
  reachedOnError: "실책 출루",
  fielderChoice: "야수선택",
  otherInPlay: "기타 타구 결과",
};
const zero = { pitches: 0, rate: 0 };

function Measurement({ value }: { value: { pitches: number; rate: number } | undefined }) {
  return value === undefined ? (
    "—"
  ) : (
    <>
      {value.pitches.toLocaleString()}구{" "}
      <span className="pitch-flow-result-rate">({outcomePercent(value.rate)})</span>
    </>
  );
}

export function PitchCountResultsTable({
  balls,
  strikes,
  columns,
}: {
  balls: number;
  strikes: number;
  columns: readonly { label: string; sample: Summary | undefined }[];
}) {
  const [expanded, setExpanded] = useState<Record<TerminalParent, boolean>>({
    strikeout: false,
    inPlay: false,
  });
  const rows: { kind: PitchCountOutcome; label: string }[] = [
    balls === 3 ? { kind: "walk", label: "볼넷" } : { kind: "ball", label: "볼" },
    strikes === 2 ? { kind: "strikeout", label: "삼진" } : { kind: "strike", label: "스트라이크" },
    ...(strikes === 2 ? [{ kind: "foul", label: "일반 파울" } as const] : []),
    { kind: "inPlay", label: "인플레이" },
    { kind: "hitByPitch", label: "몸에 맞는 공" },
    { kind: "unresolved", label: "전이 미확인" },
  ];

  return (
    <table aria-label="선택 카운트의 한 공 뒤 결과">
      <thead>
        <tr>
          <th scope="col">투구 결과</th>
          {columns.map(({ label, sample }) => (
            <th key={label} scope="col">
              {label}
              {sample !== undefined && <small>{sample.pitches.toLocaleString()}구</small>}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {rows.map(({ kind, label }) => {
          const parent = kind === "strikeout" || kind === "inPlay" ? kind : undefined;
          const details =
            parent === undefined
              ? []
              : pitchCountTerminalOutcomes[parent].filter((outcome) =>
                  columns.some(({ sample }) =>
                    sample?.terminalDetails?.some((detail) => detail.outcome === outcome),
                  ),
                );
          const isOpen = parent !== undefined && expanded[parent];
          return (
            <Fragment key={kind}>
              <tr>
                <th scope="row">
                  {parent !== undefined && details.length > 0 ? (
                    <button
                      type="button"
                      className="pitch-flow-result-toggle"
                      aria-expanded={isOpen}
                      onClick={() =>
                        setExpanded((current) => ({ ...current, [parent]: !current[parent] }))
                      }
                    >
                      <span aria-hidden="true">{isOpen ? "▾" : "▸"}</span>
                      {label}
                    </button>
                  ) : (
                    label
                  )}
                </th>
                {columns.map(({ label, sample }) => (
                  <td key={label}>
                    <Measurement
                      value={sample?.transitions.find((step) => step.outcome === kind)}
                    />
                  </td>
                ))}
              </tr>
              {isOpen &&
                details.map((outcome) => (
                  <tr key={outcome} className="pitch-flow-result-detail">
                    <th scope="row">{terminalLabels[outcome]}</th>
                    {columns.map(({ label, sample }) => (
                      <td key={label}>
                        <Measurement
                          value={
                            sample?.terminalDetails === undefined
                              ? undefined
                              : (sample.terminalDetails.find(
                                  (detail) => detail.outcome === outcome,
                                ) ?? zero)
                          }
                        />
                      </td>
                    ))}
                  </tr>
                ))}
            </Fragment>
          );
        })}
      </tbody>
    </table>
  );
}

import type { CorrectionFinding } from "@kbo/contracts";
import { parseOfficialRecordIdentity, recordFieldLabel } from "./record-comparison";

export function FindingDetails({
  code,
  details,
  recordIdentity,
}: {
  readonly code: string;
  readonly details: CorrectionFinding["details"];
  readonly recordIdentity: string | undefined;
}): React.JSX.Element | null {
  if (details.length === 0) return null;
  return (
    <ul className="finding-details">
      {details.map((detail, index) => (
        <li key={`${detail.field}:${String(index)}`}>
          {code === "domain.tracking.plate_appearance_mismatch" &&
          detail.field === "plateAppearanceEventId" ? (
            <>
              compiler PA: {findingDetailValue(detail.expected, detail.field)} · tracking PA:{" "}
              {findingDetailValue(detail.actual, detail.field)}
            </>
          ) : (
            <>
              {findingFieldLabel(detail.field, recordIdentity)}: 예상{" "}
              {findingDetailValue(detail.expected, detail.field)}
              {" → "}계산 {findingDetailValue(detail.actual, detail.field)}
            </>
          )}
        </li>
      ))}
    </ul>
  );
}

function findingFieldLabel(field: string, recordIdentity: string | undefined): string {
  const stateLabel = (
    {
      balls: "볼",
      strikes: "스트라이크",
      outs: "아웃",
      awayScore: "원정 점수",
      homeScore: "홈 점수",
      "bases.1": "1루",
      "bases.2": "2루",
      "bases.3": "3루",
    } as Readonly<Record<string, string>>
  )[field];
  if (stateLabel !== undefined) return stateLabel;
  const record = parseOfficialRecordIdentity(recordIdentity);
  return record === null ? field : (recordFieldLabel(record.kind, field) ?? field);
}

function findingDetailValue(
  value: string | number | boolean | null | undefined,
  field: string,
): string {
  if (value === undefined || value === null) return "없음";
  if (field.startsWith("bases.") && typeof value === "boolean") {
    return value ? "점유" : "비어 있음";
  }
  return String(value);
}

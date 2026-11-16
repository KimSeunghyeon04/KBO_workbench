import { outcomePercent } from "./pitch-outcome-presentation";
import "../styles/analysis-evidence.css";

// A display caution, not a statistical significance or eligibility rule.
export const SMALL_RATE_DENOMINATOR = 20;

export function SampleRate({
  value,
  denominator,
  unit,
  numerator,
}: {
  value: number | null;
  denominator: number;
  unit: string;
  numerator?: number;
}) {
  return (
    <span className="sample-rate">
      <span>{outcomePercent(denominator === 0 ? null : value)}</span>
      <small>
        {numerator === undefined ? "분모 " : `${numerator}/`}
        {denominator.toLocaleString()} {unit}
      </small>
      {denominator > 0 && denominator < SMALL_RATE_DENOMINATOR && (
        <small className="sample-rate-caution">소표본 · 분모 20 미만</small>
      )}
    </span>
  );
}

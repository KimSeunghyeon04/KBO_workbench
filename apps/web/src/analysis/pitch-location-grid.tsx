import { outcomePercent } from "./pitch-outcome-presentation";

const cellOrder = Array.from({ length: 25 }, (_, i) => Math.floor((24 - i) / 5) * 5 + (i % 5));
export interface LocationDisplayCell {
  value: number | null;
  pitches: number;
  numerator: number;
  denominator: number;
  unit: string;
}

export function PitchLocationGrid({
  cells,
  label,
  selected,
  onSelect,
  maximum = 0.5,
}: {
  cells: readonly LocationDisplayCell[];
  label: string;
  selected: number | null;
  onSelect: (cell: number) => void;
  maximum?: number;
}) {
  return (
    <div className="outcome-zone-grid" role="group" aria-label={label}>
      {cellOrder.map((index) => {
        const cell = cells[index];
        if (cell === undefined) return null;
        const small = cell.denominator < 20;
        const lightness = 95 - 60 * Math.min(1, (cell.value ?? 0) / maximum);
        return (
          <button
            type="button"
            key={index}
            aria-label={`코스 ${index}: ${cell.pitches}구`}
            aria-pressed={selected === index}
            title={`${outcomePercent(cell.value)} · ${cell.numerator}/${cell.denominator} ${cell.unit}${small ? " · 소표본" : ""}`}
            className={small ? "small-sample" : undefined}
            onClick={() => onSelect(index)}
            style={
              small
                ? undefined
                : {
                    background: `hsl(164 40% ${lightness}%)`,
                    // Both text colors exceed 4.5:1 on this fixed green scale.
                    color: lightness < 36.5 ? "#fff" : "#000",
                  }
            }
          >
            <strong>{outcomePercent(cell.value)}</strong>
            <small>{cell.pitches.toLocaleString()}구</small>
            {small && (
              <span className="outcome-sample-dot" title={`분모 20${cell.unit} 미만`}>
                ·
              </span>
            )}
          </button>
        );
      })}
      <div className="outcome-zone-outline" aria-hidden="true" />
    </div>
  );
}

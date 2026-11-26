import type { ReactNode } from "react";
import "../styles/player-statistics.css";
import "../styles/player-basic-statistics.css";

export function PlayerRecordTable({
  label,
  columns,
  rows,
}: {
  label: string;
  columns: readonly string[];
  rows: readonly { id: string | number; heading: ReactNode; values: readonly ReactNode[] }[];
}) {
  return (
    <div
      className="table-scroll player-statistics-table player-report-table"
      aria-label={label}
      role="region"
      tabIndex={0}
    >
      <table aria-label={label}>
        <thead>
          <tr>
            {columns.map((column) => (
              <th key={column} scope="col">
                {column}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map(({ id, heading, values }) => (
            <tr key={id}>
              <th scope="row">{heading}</th>
              {values.map((value, index) => (
                <td key={index}>{value}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

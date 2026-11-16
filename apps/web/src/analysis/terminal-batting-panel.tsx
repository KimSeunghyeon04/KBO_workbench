import { AnalysisEvidenceLink } from "./analysis-evidence-link";
import { useState } from "react";
import type { BatterProfileResponse } from "@kbo/contracts";
import { plateResultLabel } from "../events/relay-text";
import { replayEvidenceUrl } from "../replay/evidence-target";

export function TerminalBattingPanel({
  data,
}: {
  data: BatterProfileResponse["plateAppearances"];
}) {
  const [type, setType] = useState<string | null>(null),
    [page, setPage] = useState(0);
  const rows = data.rows.filter((r) => type === null || r.terminalType === type);
  return (
    <section className="panel outcome-terminal-panel">
      <div className="analysis-panel-heading">
        <div>
          <h2>종결 구종 기준 타석 성적</h2>
        </div>
        <span className="analysis-context-tag">투구 조건과 별도 집계</span>
      </div>
      <p>
        기간 내 공식 타석 {data.total.pa} · AB {data.total.ab} · 미귀속 {data.unattributed} · 미완료{" "}
        {data.partial}. 이 표에는 위 투구 조건을 적용하지 않습니다. 자동 판정·무투구 결과·책임
        타자와 종결 타자가 다른 결과는 미귀속에 보존합니다.
      </p>
      <div className="table-scroll" tabIndex={0}>
        <table aria-label="종결 구종 성적">
          <thead>
            <tr>
              {["종결 구종", "PA", "AB", "H", "TB", "BB", "K", "HBP", "HR", "AVG", "SLG"].map(
                (s) => (
                  <th key={s}>{s}</th>
                ),
              )}
            </tr>
          </thead>
          <tbody>
            {[data.total, ...data.byTerminalType].map((g) => (
              <tr key={g.key}>
                <th>
                  <button
                    className="outcome-table-selector"
                    aria-pressed={type === (g.key === "all" ? null : g.key)}
                    onClick={() => {
                      setType(g.key === "all" ? null : g.key);
                      setPage(0);
                    }}
                  >
                    {g.key === "all" ? "전체" : g.key}
                  </button>
                </th>
                <td>{g.pa}</td>
                <td>{g.ab}</td>
                <td>{g.hits}</td>
                <td>{g.totalBases}</td>
                <td>{g.walks}</td>
                <td>{g.strikeouts}</td>
                <td>{g.hitByPitch}</td>
                <td>{g.homeRuns}</td>
                <td>{g.avg?.toFixed(3) ?? "—"}</td>
                <td>{g.slg?.toFixed(3) ?? "—"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <details className="analysis-evidence">
        <summary>타석 기록 보기 · {rows.length.toLocaleString()}개</summary>
        <ul className="outcome-terminal-records">
          {rows.slice(page * 20, page * 20 + 20).map((r) => (
            <li key={JSON.stringify([r.gameId, r.revision, r.paId])}>
              <AnalysisEvidenceLink
                to={replayEvidenceUrl(r.gameId, r.revision, { kind: "pa", id: r.paId })}
              >
                <time>{r.gameDate}</time>
                <span>{plateResultLabel(r.result)}</span>
                <span>타석 장면 r{r.revision} ↗</span>
              </AnalysisEvidenceLink>
              <details className="outcome-pitch-id">
                <summary>타석 ID</summary>
                <code>{r.paId}</code>
              </details>
            </li>
          ))}
        </ul>
        <div className="analysis-pagination">
          <button
            className="analysis-button"
            disabled={page === 0}
            onClick={() => setPage(page - 1)}
          >
            이전 타석
          </button>
          <span>
            {page + 1} / {Math.max(1, Math.ceil(rows.length / 20))}
          </span>
          <button
            className="analysis-button"
            disabled={(page + 1) * 20 >= rows.length}
            onClick={() => setPage(page + 1)}
          >
            다음 타석
          </button>
        </div>
      </details>
    </section>
  );
}

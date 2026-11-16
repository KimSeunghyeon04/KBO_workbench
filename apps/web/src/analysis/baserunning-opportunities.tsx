import { AnalysisEvidenceLink } from "./analysis-evidence-link";
import { useState } from "react";
import type { BaserunningResponse } from "@kbo/contracts";
import { replayEvidenceUrl } from "../replay/evidence-target";
import { formatStatPercent } from "./statistics-format";
import "../styles/baserunning-opportunities.css";

const labels = {
  extra_base: "추가 진루",
  no_extra_base: "추가 진루 없음",
  out: "아웃",
  unknown: "해석 불가",
  excluded_complex: "복합 이동 제외",
};

export function BaserunningOpportunities({ data }: { data: BaserunningResponse }) {
  const [page, setPage] = useState(0);
  const summary = data.opportunitySummary;
  const name = data.players.find((row) => row.playerId === data.playerId)?.name;
  const outcomes = [
    { label: "추가 진루 성공", count: summary.extraBase },
    { label: "추가 진루 없음", count: summary.noExtraBase },
    { label: "아웃", count: summary.out },
    { label: "해석 불가", count: summary.unknown },
  ];
  return (
    <div className="baserunning-opportunities">
      <h3>{name ?? `선수 ID ${data.playerId}`} · 단타 추가 진루</h3>
      <div className="baserunning-summary">
        <dl>
          <dt>추가 진루 성공률</dt>
          <dd>{formatStatPercent(summary.extraBaseRate)}</dd>
          <dt>적격 기회 중 성공</dt>
          <dd className="baserunning-sample">
            {summary.extraBase} / {summary.eligible}회
          </dd>
        </dl>
        <ul aria-label="단타 추가 진루 결과">
          {outcomes.map((outcome) => (
            <li key={outcome.label}>
              <span>{outcome.label}</span>
              <span className="baserunning-track" aria-hidden="true">
                <i
                  style={{
                    width: `${summary.eligible === 0 ? 0 : (outcome.count / summary.eligible) * 100}%`,
                  }}
                />
              </span>
              <strong>{outcome.count}회</strong>
            </li>
          ))}
        </ul>
      </div>
      <p className="analysis-caption">
        전체 후보 {summary.candidates}회 · 복합 이동 제외 {summary.excludedComplex}회. 막대는 적격
        기회 전체를 100%로 표시합니다.
        {summary.unknown > 0 ? " 해석 불가 기회가 있어 성공률을 확정하지 않습니다." : ""}
        {summary.eligible === 0 ? " 선택한 범위에 적격 기회가 없습니다." : ""}
      </p>
      <details>
        <summary>추가 진루 기회와 성공 기준</summary>
        <p>
          이동 합계와 달리 단타 플레이당 주자 한 명을 한 기회로 셉니다. 1루→3루 이상, 2루→홈을
          성공으로 셉니다. 잔류도 분모에 포함하며 같은 플레이의 다단계 이동은 한 기회입니다. 인정
          득점이 불명확하면 비율을 확정하지 않습니다.
        </p>
      </details>
      <details>
        <summary>경기별 주루 장면 · {data.opportunities.length}기회</summary>
        {data.opportunities.length === 0 ? (
          <p>선택한 범위에 확인할 주루 장면이 없습니다.</p>
        ) : (
          <>
            <div className="table-scroll" tabIndex={0}>
              <table aria-label="추가 진루 근거">
                <thead>
                  <tr>
                    {["경기", "시작", "결과", "최종 베이스", "제외/미상 사유"].map((label) => (
                      <th key={label}>{label}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {data.opportunities.slice(page * 30, page * 30 + 30).map((row) => (
                    <tr key={JSON.stringify([row.gameId, row.revision, row.playId, row.runnerId])}>
                      <td>
                        <AnalysisEvidenceLink
                          to={replayEvidenceUrl(row.gameId, row.revision, {
                            kind: "play",
                            id: row.playId,
                          })}
                        >
                          {row.gameDate} · 주루 장면 · r{row.revision}
                        </AnalysisEvidenceLink>
                        <details className="analysis-evidence-id">
                          <summary>플레이 ID</summary>
                          <code>{row.playId}</code>
                        </details>
                      </td>
                      <td>{row.fromBase}루</td>
                      <td>{labels[row.outcome]}</td>
                      <td>{row.finalBase ?? "—"}</td>
                      <td>{row.reason ?? "—"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div className="baserunning-pagination">
              <button disabled={page === 0} onClick={() => setPage(page - 1)}>
                이전 기회
              </button>
              <span>
                {page + 1} / {Math.ceil(data.opportunities.length / 30)}
              </span>
              <button
                disabled={(page + 1) * 30 >= data.opportunities.length}
                onClick={() => setPage(page + 1)}
              >
                다음 기회
              </button>
            </div>
          </>
        )}
      </details>
    </div>
  );
}

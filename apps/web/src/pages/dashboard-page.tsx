import { Link } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";

import {
  dashboardQueryOptions,
  recordCorrectionSummaryQueryOptions,
  systemStatusQueryOptions,
} from "../api/query-options";
import { StatusBadge } from "../components/status-badge";

const workflowItems = [
  ["수집", "Naver 경기 데이터 수집"],
  ["보정", "오류 검토 및 수정"],
  ["저장", "검증 데이터 DB 적재"],
  ["재생", "DB 경기 데이터 재생"],
] as const;

export function DashboardPage(): React.JSX.Element {
  const { data, error } = useQuery({
    ...dashboardQueryOptions(),
    refetchInterval: 5_000,
  });
  const system = useQuery({
    ...systemStatusQueryOptions(),
    refetchInterval: 5_000,
  });
  const recordCorrections = useQuery(recordCorrectionSummaryQueryOptions());
  const counts = data?.counts;
  const systemReady = system.data?.status === "ready";
  const systemLoading = system.isLoading;

  return (
    <div className="page-stack">
      <header className="page-header">
        <div>
          <h1>대시보드</h1>
          <p>경기 데이터 작업 현황</p>
        </div>
        <div className="header-status">
          <span>시스템</span>
          {systemLoading ? (
            <span className="muted-text">확인 중</span>
          ) : (
            <StatusBadge healthy={systemReady} />
          )}
        </div>
      </header>

      {error !== null && <div className="error-panel">{error.message}</div>}

      <section className="metric-grid" aria-label="경기 작업 현황">
        <Metric label="수집 중" value={counts?.collecting} />
        <Metric label="검토 필요" value={counts?.reviewRequired} />
        <Metric label="적재 가능" value={counts?.readyToImport} />
        <Metric label="DB 저장" value={counts?.stored} />
      </section>

      <Link className="panel dashboard-record-correction" to="/record-corrections">
        <div>
          <strong>KBO 기록정정 검토</strong>
          <p>미반영과 수동 검토 공지를 확인합니다.</p>
        </div>
        <span>{String(recordCorrections.data?.alertCount ?? 0)}건</span>
      </Link>

      <section className="content-grid">
        <article className="panel workflow-panel">
          <div className="section-heading">
            <h2>작업 흐름</h2>
            <span className="phase-label">2단계</span>
          </div>
          <div className="workflow-list">
            {workflowItems.map(([title, description], index) => (
              <div className="workflow-item" key={title}>
                <span className="step-number">{index + 1}</span>
                <div>
                  <strong>{title}</strong>
                  <p>{description}</p>
                </div>
                <span className="item-state">{index === 0 ? "사용 가능" : "준비 중"}</span>
              </div>
            ))}
          </div>
        </article>

        <aside className="panel system-panel">
          <div className="section-heading">
            <h2>시스템</h2>
            {!systemLoading && <StatusBadge healthy={systemReady} />}
          </div>
          <dl className="system-list">
            <div>
              <dt>웹</dt>
              <dd>실행 중</dd>
            </div>
            <div>
              <dt>API / DB</dt>
              <dd>{systemReady ? "정상" : systemLoading ? "확인 중" : "확인 필요"}</dd>
            </div>
          </dl>
          <Link className="text-link" to="/settings">
            설정 열기
          </Link>
        </aside>
      </section>
    </div>
  );
}

interface MetricProps {
  readonly label: string;
  readonly value: number | undefined;
}

function Metric({ label, value }: MetricProps): React.JSX.Element {
  return (
    <article className="metric-card">
      <span>{label}</span>
      <div>
        <strong>{value ?? "—"}</strong>
        <small>경기</small>
      </div>
    </article>
  );
}

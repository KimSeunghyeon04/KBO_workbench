import { Link } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";

import {
  dashboardQueryOptions,
  recordCorrectionSummaryQueryOptions,
  systemStatusQueryOptions,
} from "../api/query-options";
import { StatusBadge } from "../components/status-badge";

const workflowItems = [
  ["수집", "경기 데이터를 수집하고 진행 상황을 확인합니다.", "/collect"],
  ["보정", "검토가 필요한 기록을 확인하고 수정합니다.", "/correct"],
  ["저장", "검증된 경기를 데이터베이스에 적재합니다.", "/database"],
  ["재생", "저장된 경기의 투구와 플레이를 살펴봅니다.", "/replay"],
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
          <p>
            {recordCorrections.isError
              ? "공지 현황을 불러오지 못했습니다. 검토 화면에서 다시 확인하세요."
              : "미반영과 수동 검토 공지를 확인합니다."}
          </p>
        </div>
        <span>
          {recordCorrections.isError
            ? "확인 필요"
            : recordCorrections.data
              ? `${recordCorrections.data.alertCount.toLocaleString()}건`
              : "확인 중"}
        </span>
      </Link>

      <section className="content-grid">
        <article className="panel workflow-panel">
          <div className="section-heading">
            <h2>작업 흐름</h2>
            <span className="phase-label">바로 이동</span>
          </div>
          <div className="workflow-list">
            {workflowItems.map(([title, description, to], index) => (
              <Link className="workflow-item" key={title} to={to}>
                <span className="step-number">{index + 1}</span>
                <div>
                  <strong>{title}</strong>
                  <p>{description}</p>
                </div>
                <span className="item-state" aria-hidden="true">
                  열기 →
                </span>
              </Link>
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

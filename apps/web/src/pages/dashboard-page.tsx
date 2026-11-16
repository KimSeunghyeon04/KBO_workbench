import { Link } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";

import {
  dashboardQueryOptions,
  recordCorrectionSummaryQueryOptions,
  systemStatusQueryOptions,
} from "../api/query-options";
import { StatusBadge } from "../components/status-badge";
import "../styles/dashboard.css";

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
    <div className="page-stack dashboard-page">
      <header className="page-header">
        <div>
          <h1>대시보드</h1>
          <p>수집한 기록을 검토하고, 저장된 경기에서 분석을 시작하세요.</p>
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
        <Metric
          label="진행 중인 수집 작업"
          value={counts?.collecting}
          to="/collect?tab=history"
          unit="건"
        />
        <Metric label="검토 필요" value={counts?.reviewRequired} to="/correct" />
        <Metric label="적재 가능" value={counts?.readyToImport} to="/database?scope=ready" />
        <Metric label="DB 저장" value={counts?.stored} to="/database?scope=stored" />
      </section>

      <section className="dashboard-workspace">
        <article className="dashboard-tasks">
          <h2>데이터 관리</h2>
          <p className="muted-text">수집 → 검토·보정 → DB 저장 순서로 기록을 준비합니다.</p>
          <Link className="dashboard-task" to="/collect">
            <div>
              <strong>경기 수집</strong>
              <p>기간별 일정을 확인하고 필요한 경기를 가져옵니다.</p>
            </div>
            <span>기간 선택</span>
          </Link>
          <Link className="dashboard-task" to="/correct">
            <div>
              <strong>기록 검토·보정</strong>
              <p>원문과 검증 결과를 함께 보며 기록을 수정합니다.</p>
            </div>
            <span data-attention={(counts?.reviewRequired ?? 0) > 0}>
              {counts ? `${counts.reviewRequired.toLocaleString()}경기 검토` : "현황 확인"}
            </span>
          </Link>
          <Link className="dashboard-task" to="/database?scope=ready">
            <div>
              <strong>검증된 경기 저장</strong>
              <p>적재 가능한 기록을 분석과 재생에 사용할 수 있게 저장합니다.</p>
            </div>
            <span>
              {counts ? `${counts.readyToImport.toLocaleString()}경기 적재 가능` : "현황 확인"}
            </span>
          </Link>
          <Link className="dashboard-task" to="/record-corrections">
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
        </article>
        <aside className="dashboard-explore">
          <h2>기록에서 분석으로</h2>
          <p>선수의 기본 기록부터 구질·코스·변화까지, 수집한 경기의 근거를 따라 살펴보세요.</p>
          <Link className="primary-button" to="/analysis/players">
            선수 분석 시작
          </Link>
          <Link className="dashboard-explore-link" to="/replay">
            <strong>경기 재생</strong>
            <span>투구와 플레이를 장면별로 확인</span>
          </Link>
          <Link className="dashboard-explore-link" to="/analysis/coverage">
            <strong>자료 품질</strong>
            <span>분석 가능한 범위와 누락 확인</span>
          </Link>
        </aside>
      </section>
      <section className="dashboard-system" aria-label="시스템 상태">
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
          설정 및 진단
        </Link>
      </section>
    </div>
  );
}

interface MetricProps {
  readonly label: string;
  readonly value: number | undefined;
  readonly to: string;
  readonly unit?: string;
}

function Metric({ label, value, to, unit = "경기" }: MetricProps): React.JSX.Element {
  return (
    <Link className="metric-card" to={to}>
      <span>{label}</span>
      <div>
        <strong>{value?.toLocaleString() ?? "—"}</strong>
        <small>{unit}</small>
      </div>
    </Link>
  );
}

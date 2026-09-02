import { useQuery } from "@tanstack/react-query";

import { systemStatusQueryOptions } from "../api/query-options";
import { StatusBadge } from "../components/status-badge";

export function SettingsPage(): React.JSX.Element {
  const { data, error, isLoading } = useQuery(systemStatusQueryOptions());

  return (
    <div className="page-stack narrow-page">
      <header className="page-header">
        <div>
          <h1>설정 및 진단</h1>
          <p>서비스와 저장소 상태</p>
        </div>
        {!isLoading && data !== undefined && <StatusBadge healthy={data.status === "ready"} />}
      </header>

      {isLoading && <div className="panel loading-panel">시스템 상태를 확인하고 있습니다.</div>}
      {error !== null && <div className="error-panel">{error.message}</div>}

      {data !== undefined ? (
        <>
          <section className="diagnostic-grid">
            <DiagnosticCard
              label="API"
              title={`버전 ${data.apiVersion}`}
              healthy={data.status === "ready"}
              details="상태 API 응답"
            />
            <DiagnosticCard
              label="데이터베이스"
              title={`PostgreSQL ${data.database.serverMajorVersion ?? "—"}`}
              healthy={data.database.healthy}
              details={data.database.message}
            />
            <DiagnosticCard
              label="마이그레이션"
              title={data.database.migrationVersion ?? "적용 기록 없음"}
              healthy={data.database.migrationVersion === data.database.expectedMigrationVersion}
              details={`기준 버전: ${data.database.expectedMigrationVersion}`}
            />
            <DiagnosticCard
              label="작업 공간"
              title={data.workspace.writable ? "읽기·쓰기 가능" : "접근 불가"}
              healthy={data.workspace.writable}
              details={`${data.workspace.path} · ${data.workspace.message}`}
            />
            <DiagnosticCard
              label="수집 브라우저"
              title={
                data.browser.version === null
                  ? "Playwright 버전 확인 불가"
                  : `Playwright ${data.browser.version}`
              }
              healthy={data.browser.installed}
              details={data.browser.message}
            />
          </section>
          <section className="panel recent-failures-panel">
            <div className="section-heading">
              <h2>최근 실패 작업</h2>
              <span className="muted-text">최근 {data.recentFailures.length}개</span>
            </div>
            <div className="recent-failure-list">
              {data.recentFailures.map((failure) => (
                <article key={`${failure.kind}:${failure.jobId}`}>
                  <span className={`failure-category ${failure.category}`}>
                    {categoryLabel(failure.category)}
                  </span>
                  <div>
                    <strong>{failure.kind === "collection" ? "수집" : "DB 적재"}</strong>
                    <p>{failure.message}</p>
                  </div>
                  <time dateTime={failure.occurredAt}>{formatDateTime(failure.occurredAt)}</time>
                </article>
              ))}
              {data.recentFailures.length === 0 ? (
                <p className="muted-text">현재 프로세스에서 실패한 작업이 없습니다.</p>
              ) : null}
            </div>
          </section>
        </>
      ) : null}

      <section className="panel contract-panel">
        <div className="section-heading">
          <h2>연결 구조</h2>
          <span className="muted-text">웹 포트만 공개</span>
        </div>
        <div className="network-line" aria-label="네트워크 연결 구조">
          <span>브라우저</span>
          <i aria-hidden="true" />
          <span>웹</span>
          <i aria-hidden="true" />
          <span>API</span>
          <i aria-hidden="true" />
          <span>PostgreSQL</span>
        </div>
      </section>
    </div>
  );
}

function categoryLabel(category: "source" | "domain" | "persistence"): string {
  return { source: "원천", domain: "규칙", persistence: "저장" }[category];
}

function formatDateTime(value: string): string {
  return new Intl.DateTimeFormat("ko-KR", { dateStyle: "short", timeStyle: "short" }).format(
    new Date(value),
  );
}

interface DiagnosticCardProps {
  readonly details: string;
  readonly healthy: boolean;
  readonly label: string;
  readonly title: string;
}

function DiagnosticCard({
  details,
  healthy,
  label,
  title,
}: DiagnosticCardProps): React.JSX.Element {
  return (
    <article className="diagnostic-card">
      <div className="diagnostic-topline">
        <span>{label}</span>
        <StatusBadge healthy={healthy} />
      </div>
      <h2>{title}</h2>
      <p>{details}</p>
    </article>
  );
}

import * as React from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "react-router-dom";
import type { CollectionCounts, CollectionGameSummary, CollectionJob } from "@kbo/contracts";
import { createCorrectionSession } from "../api/correction-client";
import {
  collectionHistoryOptions,
  collectionHistoryDetailOptions,
  collectionHistoryItemsOptions,
} from "../api/collection-operations-client";
import {
  storageLabel,
  outcomeLabel,
  jobStatusLabel,
  dateTimeLabel,
  rangeLabel,
} from "./navigation";

export function Pagination({
  page,
  total,
  limit = 50,
  onChange,
}: {
  page: number;
  total: number;
  limit?: number;
  onChange: (page: number) => void;
}): React.JSX.Element {
  const pages = Math.max(1, Math.ceil(total / limit));
  return (
    <nav className="collection-pagination" aria-label="페이지 이동">
      <span>
        전체 {total.toLocaleString("ko-KR")}건 · {page} / {pages}페이지
      </span>
      <button className="secondary-button" disabled={page <= 1} onClick={() => onChange(page - 1)}>
        이전
      </button>
      <button
        className="secondary-button"
        disabled={page >= pages}
        onClick={() => onChange(page + 1)}
      >
        다음
      </button>
    </nav>
  );
}
export function Counts({ counts }: { counts: CollectionCounts | undefined }): React.JSX.Element {
  const columns = [
    ["total", "전체"],
    ["uncollected", "미수집"],
    ["staging", "적재 가능"],
    ["quarantine", "검토 필요"],
    ["source_failure", "원천 실패"],
    ["database", "DB 저장"],
  ] as const;
  return (
    <dl className="collection-counts">
      {columns.map(([key, label]) => (
        <div key={key} className={key}>
          <dt>{label}</dt>
          <dd>{counts?.[key]?.toLocaleString("ko-KR") ?? "—"}</dd>
        </div>
      ))}
    </dl>
  );
}
export function GameDetail({
  game,
  onClose,
  onRetry,
}: {
  game: CollectionGameSummary;
  onClose: () => void;
  onRetry: () => void;
}): React.JSX.Element {
  const navigate = useNavigate();
  const correction = useMutation({
    mutationFn: async () => {
      if (game.state !== "staging" && game.state !== "quarantine")
        throw new Error("보정 가능한 작업본이 없습니다.");
      return createCorrectionSession(game.state, game.gameId);
    },
    onSuccess: (session) => {
      void navigate(`/correct?sessionId=${encodeURIComponent(session.sessionId)}`);
    },
  });
  return (
    <aside className="panel collection-detail" aria-label="경기 상세">
      <div className="collection-toolbar">
        <h2>{game.label}</h2>
        <button className="secondary-button" onClick={onClose}>
          상세 닫기
        </button>
      </div>
      <p>{game.gameDate ?? "경기 날짜 미확인"}</p>
      <dl className="operation-detail-fields">
        <div>
          <dt>저장 상태</dt>
          <dd>
            {storageLabel[game.state]}
            {game.workspace !== null && game.databaseRevision !== null ? " · DB에도 저장됨" : ""}
          </dd>
        </div>
        <div>
          <dt>검증 결과</dt>
          <dd>
            {game.state === "uncollected"
              ? "수집 후 확인"
              : `차단 ${game.blockingFindings} · 경고 ${game.warningFindings}`}
          </dd>
        </div>
        <div>
          <dt>최근 변경</dt>
          <dd>{game.updatedAt === null ? "—" : dateTimeLabel(game.updatedAt)}</dd>
        </div>
      </dl>
      <div className="collection-detail-actions">
        {game.state === "staging" || game.state === "quarantine" ? (
          <button
            className="primary-button"
            disabled={correction.isPending}
            onClick={() => correction.mutate()}
          >
            보정 작업대로 이동
          </button>
        ) : null}
        {game.state === "staging" ? (
          <button
            className="secondary-button"
            onClick={() => {
              void navigate(`/database?scope=ready&game=${encodeURIComponent(game.gameId)}`);
            }}
          >
            DB 적재 화면으로 이동
          </button>
        ) : null}
        {game.databaseRevision !== null ? (
          <button
            className="secondary-button"
            onClick={() => {
              void navigate(`/database?scope=stored&game=${encodeURIComponent(game.gameId)}`);
            }}
          >
            DB 조회
          </button>
        ) : null}
        {game.state === "source_failure" ? (
          <button className="primary-button" onClick={onRetry}>
            이 경기 재시도 대상으로 설정
          </button>
        ) : null}
      </div>
      {correction.error !== null ? (
        <p className="inline-error">{correction.error.message}</p>
      ) : null}
      <details className="collection-technical">
        <summary>기술 정보</summary>
        <dl>
          <dt>경기 ID</dt>
          <dd className="mono-text">{game.gameId}</dd>
          <dt>DB revision</dt>
          <dd>{game.databaseRevision ?? "—"}</dd>
        </dl>
      </details>
    </aside>
  );
}
export function ActiveJob({
  job,
  onCancel,
  onOpen,
}: {
  job: CollectionJob;
  onCancel: () => void;
  onOpen: () => void;
}): React.JSX.Element {
  return (
    <section className="active-operation-banner" aria-live="polite">
      <button className="active-operation-copy" onClick={onOpen}>
        <strong>
          {jobStatusLabel[job.status]} · {job.completedItems} / {job.totalItems ?? "—"}경기
        </strong>
        <span>
          성공 {job.summary.ready} · 검토 필요 {job.summary.quarantined} · 원천 실패{" "}
          {job.summary.sourceFailures} · 변경 없음 {job.summary.unchanged ?? 0} · 건너뜀{" "}
          {job.skippedItems}
        </span>
        {job.currentGameId !== null ? <span>현재 경기 {job.currentGameId}</span> : null}
      </button>
      <progress
        value={job.completedItems}
        max={Math.max(1, job.totalItems ?? 1)}
        aria-label="수집 진행률"
      />
      <button
        className="secondary-button"
        disabled={job.status === "cancelling"}
        onClick={onCancel}
      >
        취소
      </button>
    </section>
  );
}
export function CollectionHistory({
  page,
  jobId,
  resultPage,
  problemsOnly,
  update,
}: {
  page: number;
  jobId: string;
  resultPage: number;
  problemsOnly: boolean;
  update: (values: Record<string, string | null>) => void;
}): React.JSX.Element {
  const history = useQuery(collectionHistoryOptions(page));
  const client = useQueryClient();
  const detail = useQuery({
    ...collectionHistoryDetailOptions(jobId),
    refetchInterval: (query) => {
      const status = query.state.data?.job.status;
      return status === "queued" || status === "running" || status === "cancelling" ? 2_000 : false;
    },
  });
  const status = detail.data?.job.status;
  React.useEffect(() => {
    if (jobId !== "")
      void client.invalidateQueries({
        queryKey: collectionHistoryItemsOptions(jobId, resultPage, problemsOnly).queryKey,
      });
  }, [client, jobId, resultPage, problemsOnly, status, detail.data?.job.completedItems]);
  const items = useQuery({
    ...collectionHistoryItemsOptions(jobId, resultPage, problemsOnly),
    refetchInterval:
      status === "queued" || status === "running" || status === "cancelling" ? 2_000 : false,
  });
  const job = detail.data?.job;
  const error = history.error ?? detail.error ?? items.error;
  return (
    <section className="panel collection-history" aria-label="수집 기록">
      <div className="collection-toolbar">
        <div>
          <h2>{jobId === "" ? "수집 기록" : "작업 결과"}</h2>
          <p className="muted-text">수집 당시 결과는 보정·DB 적재 후에도 유지됩니다.</p>
        </div>
        {jobId !== "" ? (
          <button
            className="secondary-button"
            onClick={() => update({ job: null, resultPage: null })}
          >
            기록 목록으로
          </button>
        ) : null}
      </div>
      {error !== null ? <p className="inline-error">{error.message}</p> : null}
      {jobId === "" ? (
        <>
          <div className="collection-table-scroll">
            <table className="collection-table">
              <thead>
                <tr>
                  <th>시작 시각 · 대상</th>
                  <th>상태</th>
                  <th>처리</th>
                  <th>성공</th>
                  <th>검토 필요</th>
                  <th>원천 실패</th>
                  <th>변경 없음 / 건너뜀</th>
                </tr>
              </thead>
              <tbody>
                {history.data?.records.map((record) => (
                  <tr key={record.job.jobId}>
                    <th>
                      <button
                        className="collection-row-link"
                        onClick={() =>
                          update({ job: record.job.jobId, resultPage: null, results: null })
                        }
                      >
                        {dateTimeLabel(record.job.createdAt)}
                        <small>
                          {record.range === null
                            ? `${record.job.totalItems ?? "—"}경기 지정`
                            : rangeLabel(record.range)}
                        </small>
                      </button>
                    </th>
                    <td>{jobStatusLabel[record.job.status]}</td>
                    <td>
                      {record.job.completedItems} / {record.job.totalItems ?? "—"}
                    </td>
                    <td>{record.job.summary.ready}</td>
                    <td>{record.job.summary.quarantined}</td>
                    <td>{record.job.summary.sourceFailures}</td>
                    <td>
                      {record.job.summary.unchanged ?? 0} / {record.job.skippedItems}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {history.data?.total === 0 ? (
            <div className="collection-empty">아직 보존된 수집 기록이 없습니다.</div>
          ) : null}
          <Pagination
            page={page}
            total={history.data?.total ?? 0}
            onChange={(next) => update({ historyPage: String(next) })}
          />
        </>
      ) : (
        <>
          {job !== undefined ? (
            <div className="collection-history-summary">
              <strong>
                {jobStatusLabel[job.status]} · {job.completedItems} / {job.totalItems ?? "—"}경기
              </strong>
              <span>
                성공 {job.summary.ready} · 검토 필요 {job.summary.quarantined} · 원천 실패{" "}
                {job.summary.sourceFailures} · 변경 없음 {job.summary.unchanged ?? 0} · 건너뜀{" "}
                {job.skippedItems}
              </span>
              {job.error !== null ? <p className="inline-error">{job.error}</p> : null}
            </div>
          ) : null}
          <div className="collection-toolbar">
            <label>
              결과 보기
              <select
                aria-label="작업 결과 필터"
                value={problemsOnly ? "problems" : "all"}
                onChange={(event) => update({ results: event.target.value, resultPage: null })}
              >
                <option value="problems">실패·검토 필요·중단 먼저</option>
                <option value="all">전체 결과</option>
              </select>
            </label>
          </div>
          <div className="collection-table-scroll">
            <table className="collection-table">
              <thead>
                <tr>
                  <th>경기</th>
                  <th>수집 당시 결과</th>
                  <th>현재 저장 상태</th>
                  <th>처리 내용</th>
                </tr>
              </thead>
              <tbody>
                {items.data?.items.map(({ result, current }) => (
                  <tr key={result.gameId}>
                    <th>
                      {result.label}
                      <small>{result.gameDate ?? "날짜 미확인"}</small>
                    </th>
                    <td>{outcomeLabel[result.outcome]}</td>
                    <td>{current === null ? "보유 자료 없음" : storageLabel[current.state]}</td>
                    <td>{result.message}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {items.data?.total === 0 ? (
            <div className="collection-empty">
              {problemsOnly
                ? "실패·검토 필요·중단 결과가 없습니다. 전체 결과에서 완료 내역을 볼 수 있습니다."
                : "아직 처리 결과가 없습니다."}
            </div>
          ) : null}
          <Pagination
            page={resultPage}
            total={items.data?.total ?? 0}
            onChange={(next) => update({ resultPage: String(next) })}
          />
        </>
      )}
    </section>
  );
}

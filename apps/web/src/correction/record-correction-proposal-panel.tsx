import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type {
  CorrectionMutationResult,
  CorrectionSession,
  RecordCorrectionCase,
} from "@kbo/contracts";

import { applyRecordCorrectionProposal } from "../api/client";
import {
  queryKeys,
  recordCorrectionCaseQueryOptions,
  recordCorrectionProposalQueryOptions,
} from "../api/query-options";

export function RecordCorrectionProposalPanel(props: {
  readonly session: CorrectionSession;
  readonly noticeId: string;
  readonly onApplied: (result: CorrectionMutationResult) => void;
}): React.JSX.Element {
  const queryClient = useQueryClient();
  const correctionCase = useQuery(recordCorrectionCaseQueryOptions(props.noticeId));
  const proposal = useQuery(
    recordCorrectionProposalQueryOptions(props.session.sessionId, props.noticeId),
  );
  const apply = useMutation({
    mutationFn: async () => {
      if (proposal.data === undefined) throw new Error("KBO 정정 제안이 없습니다.");
      return applyRecordCorrectionProposal(
        props.session.sessionId,
        props.noticeId,
        props.session.sessionVersion,
        proposal.data.proposalHash,
      );
    },
    async onSuccess(result) {
      props.onApplied(result);
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: queryKeys.recordCorrections.all }),
        queryClient.invalidateQueries({ queryKey: queryKeys.catalog }),
        queryClient.invalidateQueries({ queryKey: queryKeys.dashboard }),
      ]);
    },
  });
  const data = proposal.data;
  return (
    <section className="panel record-correction-proposal">
      <div className="section-heading">
        <div>
          <h2>KBO 기록정정 제안</h2>
          <p className="muted-text">
            제안 적용은 이 작업 사본만 변경합니다. 저장과 DB 적재는 아래 기존 절차에서 따로
            확인합니다.
          </p>
        </div>
        <button
          type="button"
          className="primary-button"
          disabled={data?.eligible !== true || data.batch === null || apply.isPending}
          onClick={() => apply.mutate()}
        >
          제안 적용
        </button>
      </div>
      {proposal.isLoading ? <p className="muted-text">제안을 검증하는 중입니다.</p> : null}
      {correctionCase.isLoading ? (
        <p className="muted-text">기록정정 내용을 불러오는 중입니다.</p>
      ) : null}
      {correctionCase.error !== null ? (
        <p className="inline-error">{correctionCase.error.message}</p>
      ) : null}
      {proposal.error !== null ? <p className="inline-error">{proposal.error.message}</p> : null}
      {apply.error !== null ? <p className="inline-error">{apply.error.message}</p> : null}
      {correctionCase.data !== undefined ? (
        <RecordCorrectionNoticeContext item={correctionCase.data} />
      ) : null}
      {data !== undefined ? (
        <>
          {data.reasons.length > 0 ? (
            <ul className="record-correction-proposal-reasons">
              {data.reasons.map((reason) => (
                <li key={reason}>{reason}</li>
              ))}
            </ul>
          ) : null}
          <div className="record-correction-proposal-changes">
            {data.changes.map((change, index) => (
              <div key={`${change.kind}:${change.field}:${String(index)}`}>
                <span>{changeKindLabel(change.kind)}</span>
                <strong>{change.field}</strong>
                <code>
                  {String(change.beforeValue ?? "—")} → {String(change.afterValue ?? "—")}
                </code>
                <small>{changeStateLabel(change.state)}</small>
              </div>
            ))}
          </div>
          {data.preview !== null ? (
            <p className="muted-text">
              전체 컴파일: 차단 {String(data.preview.beforeBlockingCount)} →{" "}
              {String(data.preview.afterBlockingCount)}, 경고{" "}
              {String(data.preview.beforeWarningCount)} → {String(data.preview.afterWarningCount)}
            </p>
          ) : null}
        </>
      ) : null}
    </section>
  );
}

function RecordCorrectionNoticeContext(props: {
  readonly item: RecordCorrectionCase;
}): React.JSX.Element {
  const notice = props.item.notice;
  return (
    <section className="record-correction-proposal-context" aria-label="KBO 기록정정 내용">
      <div className="record-correction-proposal-context-heading">
        <h3>기록정정 내용</h3>
        <small>
          KBO #{String(notice.recordNumber)} · {notice.seriesName}
        </small>
      </div>
      <dl className="record-correction-fields">
        <div>
          <dt>경기</dt>
          <dd>
            {notice.gameDate} · {notice.awayTeamName} vs {notice.homeTeamName} · {notice.venueName}
            {notice.doubleheaderNumber === null ? "" : ` · DH${String(notice.doubleheaderNumber)}`}
          </dd>
        </div>
        <div>
          <dt>플레이</dt>
          <dd>
            {String(notice.inning)}회 {notice.half === "top" ? "초" : "말"} ·{" "}
            {String(notice.battingOrder)}번 타자
          </dd>
        </div>
        <div>
          <dt>판정</dt>
          <dd>
            {notice.beforeRecordText} → {notice.afterRecordText}
          </dd>
        </div>
        <div>
          <dt>정정일</dt>
          <dd>{notice.correctionDateText}</dd>
        </div>
        <div>
          <dt>매칭 근거</dt>
          <dd>{props.item.reasonMessage}</dd>
        </div>
      </dl>
      <div className="record-correction-source-content">
        <strong>KBO 공지 내용</strong>
        <p>{notice.contentText}</p>
      </div>
      <h4>전후 공식 기록</h4>
      <div className="record-correction-stat-list">
        {notice.statChanges.map((stat) => {
          const participant =
            stat.participantIndex === null ? undefined : notice.participants[stat.participantIndex];
          return (
            <div key={stat.statIndex}>
              <strong>{participant?.rawPlayerName ?? "선수 미지정"}</strong>
              <span>
                {stat.rawStatName}: {String(stat.beforeValue)} → {String(stat.afterValue)}
              </span>
              <small>{supportKindLabel(stat.supportKind)}</small>
            </div>
          );
        })}
        {notice.statChanges.length === 0 ? (
          <p className="muted-text">구조화된 통계 변경이 없습니다.</p>
        ) : null}
      </div>
    </section>
  );
}

function changeKindLabel(kind: string): string {
  return (
    {
      event: "플레이",
      official_batter: "타자 공식 기록",
      official_pitcher: "투수 공식 기록",
      derived: "파생 검증",
      evidence_only: "현 범위 제외",
    }[kind] ?? kind
  );
}

function changeStateLabel(state: string): string {
  return (
    {
      change: "변경 예정",
      already_applied: "이미 반영",
      verified: "검증 완료",
      evidence_only: "증거 보존",
      conflict: "충돌",
    }[state] ?? state
  );
}

function supportKindLabel(kind: string): string {
  return (
    {
      direct: "적용 지원",
      derived: "파생 검증",
      evidence_only: "현 범위 제외",
      unknown: "미분류·범위 제외",
    }[kind] ?? kind
  );
}

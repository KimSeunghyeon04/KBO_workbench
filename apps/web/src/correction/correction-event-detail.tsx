import type {
  CorrectionCommand,
  CorrectionEventContext,
  CorrectionFinding,
  CorrectionSourceEvidence,
  StagingGameDocumentV2,
  StagingRelayEvent,
} from "@kbo/contracts";
import { FindingDetails } from "./correction-finding-details";
import { newCommandId } from "./event-editor-registry";
import { eventKindLabel, type EventPresentation } from "./event-presentation";
import { PitchTrackingDetail } from "./pitch-tracking-detail";
import { focusedSourceEvidence } from "./source-evidence-presentation";
import { isRepairableTrackingPlateAppearanceFinding } from "./tracking-review";

export function EventDetail({
  presentation,
  context,
  findings,
  document,
  eventContexts,
  exceptionTrackingId,
  sourceEvidence,
  sourceEvidencePending,
  sourceEvidenceError,
  pending,
  onApply,
}: {
  readonly presentation: EventPresentation | undefined;
  readonly context: CorrectionEventContext | undefined;
  readonly findings: readonly CorrectionFinding[];
  readonly document: StagingGameDocumentV2;
  readonly eventContexts: readonly CorrectionEventContext[];
  readonly exceptionTrackingId: string | null;
  readonly sourceEvidence: CorrectionSourceEvidence | undefined;
  readonly sourceEvidencePending: boolean;
  readonly sourceEvidenceError: Error | null;
  readonly pending: boolean;
  readonly onApply: (command: CorrectionCommand) => void;
}): React.JSX.Element {
  const event = presentation?.event;
  const exceptionOnly = event === undefined && exceptionTrackingId !== null;
  return (
    <section className="panel correction-detail">
      <div className="panel-title-row">
        <h2>선택한 원장 행</h2>
        <span>{event === undefined ? "-" : eventKindLabel(event.kind)}</span>
      </div>
      {event === undefined || presentation === undefined ? (
        exceptionOnly ? (
          <div className="event-detail-body">
            <p className="muted-text">
              대응하는 원장 투구 행을 찾지 못한 원천 tracking 관측입니다.
            </p>
            <PitchTrackingDetail
              document={document}
              eventContexts={eventContexts}
              pitchEventId={null}
              exceptionTrackingId={exceptionTrackingId}
              pending={pending}
              onApply={onApply}
            />
          </div>
        ) : (
          <p className="muted-text event-detail-body">중계 행을 선택하세요.</p>
        )
      ) : (
        <div className="event-detail-body">
          <article className="event-detail-summary">
            <span>
              {presentation.location} · #{String(event.sequence + 1)} · {presentation.kindLabel}
            </span>
            <h3>{event.relayText ?? "원문 없음"}</h3>
            <p>{presentation.summary}</p>
            {event.kind === "runner_advance" && event.payload.context.kind === "plate_result" ? (
              <small className="movement-parent-reference">
                타석 결과 {event.payload.context.plateResultEventId}에 연결
              </small>
            ) : null}
          </article>
          {context === undefined ? (
            <p className="muted-text">이 행의 compiler 상태를 계산하지 못했습니다.</p>
          ) : (
            <div className="event-state-comparison">
              <div>
                <span>적용 전</span>
                <p>{formatState(context.before, document)}</p>
              </div>
              <b aria-hidden="true">→</b>
              <div>
                <span>적용 후</span>
                <p>{formatState(context.after, document)}</p>
              </div>
              {!context.applied ? (
                <em>blocking finding으로 이 행의 상태 적용이 보류됐습니다.</em>
              ) : null}
            </div>
          )}
          <div className="event-related-findings">
            <div className="panel-title-row">
              <h3>관련 finding</h3>
              <span>{String(findings.length)}건</span>
            </div>
            {findings.length === 0 ? (
              <p className="muted-text">이 행에 직접 연결된 finding이 없습니다.</p>
            ) : (
              findings.map((finding) => {
                const repairable = isRepairableTrackingPlateAppearanceFinding(
                  document,
                  eventContexts,
                  finding,
                );
                return (
                  <article
                    className={finding.severity}
                    key={`${finding.code}:${finding.message}:${finding.eventSequence ?? "game"}`}
                  >
                    <span>
                      {finding.severity === "blocking" ? "차단" : "경고"} · {finding.category}
                    </span>
                    <strong>{finding.message}</strong>
                    <FindingDetails
                      code={finding.code}
                      details={finding.details}
                      recordIdentity={finding.recordIdentity}
                    />
                    {repairable ? (
                      <button
                        type="button"
                        className="text-button"
                        disabled={pending}
                        onClick={() =>
                          onApply({
                            commandId: newCommandId(),
                            kind: "reconcile_tracking_plate_appearance_contexts",
                          })
                        }
                      >
                        삭제된 PA 문맥 재계산
                      </button>
                    ) : null}
                    <small>{finding.code}</small>
                  </article>
                );
              })
            )}
          </div>
          {event.kind === "pitch" ? (
            <PitchTrackingDetail
              document={document}
              eventContexts={eventContexts}
              pitchEventId={event.identity.eventId}
              exceptionTrackingId={exceptionTrackingId}
              pending={pending}
              onApply={onApply}
            />
          ) : null}
          <details className="event-technical-details">
            <summary>원천 증거와 정규화 값</summary>
            <dl>
              <div>
                <dt>event ID</dt>
                <dd>{event.identity.eventId}</dd>
              </div>
              <div>
                <dt>원천 위치</dt>
                <dd>{sourceLocation(event)}</dd>
              </div>
              <div>
                <dt>적용 상태</dt>
                <dd>{context === undefined ? "계산 없음" : context.applied ? "적용" : "차단"}</dd>
              </div>
            </dl>
            <h4>정규화 payload</h4>
            <pre>{JSON.stringify(event.payload, null, 2)}</pre>
            {sourceEvidencePending ? (
              <p className="muted-text">원천 행을 불러오는 중입니다.</p>
            ) : null}
            {sourceEvidenceError == null ? null : (
              <p className="inline-error">{sourceEvidenceError.message}</p>
            )}
            {sourceEvidence === undefined ? null : <SourceEvidenceRows evidence={sourceEvidence} />}
          </details>
        </div>
      )}
    </section>
  );
}

function SourceEvidenceRows({
  evidence,
}: {
  readonly evidence: CorrectionSourceEvidence;
}): React.JSX.Element {
  return (
    <div className="source-evidence-rows">
      <h4>선택 행과 앞뒤 원문</h4>
      {evidence.relayRows.map((row) => (
        <article className={row.selected ? "selected" : ""} key={`relay:${String(row.rowIndex)}`}>
          <strong>
            row {String(row.rowIndex)} · seqno{" "}
            {row.sourceSequence === null ? "없음" : String(row.sourceSequence)}
            {row.selected ? " · 선택 행" : ""}
          </strong>
          <pre>{focusedSourceEvidence(row.canonicalJson)}</pre>
          <details>
            <summary>전체 원문 JSON</summary>
            <pre>{prettyCanonicalJson(row.canonicalJson)}</pre>
          </details>
        </article>
      ))}
      <h4>같은 block의 관련 PTS 원문</h4>
      {evidence.trackingRows.length === 0 ? (
        <p className="muted-text">이 행과 같은 sourcePitchId의 PTS 원문이 없습니다.</p>
      ) : (
        evidence.trackingRows.map((row) => (
          <article key={`tracking:${String(row.rowIndex)}`}>
            <strong>
              row {String(row.rowIndex)} · sourcePitchId {row.sourcePitchId ?? "없음"}
            </strong>
            <pre>{prettyCanonicalJson(row.canonicalJson)}</pre>
          </article>
        ))
      )}
    </div>
  );
}

function prettyCanonicalJson(value: string): string {
  try {
    return JSON.stringify(JSON.parse(value) as unknown, null, 2);
  } catch {
    return value;
  }
}

function sourceLocation(event: StagingRelayEvent): string {
  return event.identity.kind === "source"
    ? `${event.identity.endpoint} · block ${String(event.identity.blockIndex)}, row ${String(event.identity.eventIndex)}`
    : "수동 보정 행";
}

function formatState(
  state: CorrectionEventContext["before"],
  document: StagingGameDocumentV2,
): string {
  const names = new Map(
    [...document.rosters.away.players, ...document.rosters.home.players].map((player) => [
      player.playerId,
      player.name,
    ]),
  );
  const bases = state.bases
    .map((runnerId, index) =>
      runnerId === null ? "" : `${String(index + 1)}루 ${names.get(runnerId) ?? runnerId}`,
    )
    .filter(Boolean)
    .join(" · ");
  return `B${String(state.balls)} S${String(state.strikes)} O${String(state.outs)} · ${bases || "주자 없음"} · ${String(state.awayScore)}:${String(state.homeScore)}`;
}

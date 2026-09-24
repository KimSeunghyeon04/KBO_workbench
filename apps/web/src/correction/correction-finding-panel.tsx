import type {
  CorrectionEventContext,
  CorrectionSession,
  StagingGameDocumentV2,
} from "@kbo/contracts";
import { useMemo, useState } from "react";
import { FindingDetails } from "./correction-finding-details";
import {
  buildDisplayFindings,
  findingIdentity,
  groupDisplayFindings,
  type DisplayFinding,
} from "./finding-presentation";
import { parseOfficialRecordIdentity, recordIdentityLabel } from "./record-comparison";
import {
  trackingCandidateForFinding,
  trackingCandidatesForFinding,
  trackingFindingLocation,
  trackingSourceLocation,
} from "./tracking-review";

export function FindingPanel({
  session,
  selectedEventId,
  selectedRecordIdentity,
  selectedTrackingId,
  onSelectEvent,
  onSelectRecord,
  onSelectTracking,
}: {
  readonly session: Pick<
    CorrectionSession,
    "storedFindings" | "findings" | "draftDocument" | "eventContexts"
  >;
  readonly selectedEventId: string | null;
  readonly selectedRecordIdentity: string | null;
  readonly selectedTrackingId: string | null;
  readonly onSelectEvent: (id: string) => void;
  readonly onSelectRecord: (recordIdentity: string) => void;
  readonly onSelectTracking: (trackingId: string) => void;
}): React.JSX.Element {
  const [query, setQuery] = useState("");
  const [severity, setSeverity] = useState("all");
  const [category, setCategory] = useState("all");
  const [origin, setOrigin] = useState<"current" | "stored" | "all">("current");
  const allFindings = useMemo(
    () => buildDisplayFindings(session, origin !== "current"),
    [origin, session],
  );
  const normalizedQuery = query.trim().toLocaleLowerCase("ko-KR");
  const visibleFindings = allFindings.filter((finding) => {
    if (severity !== "all" && finding.severity !== severity) return false;
    if (category !== "all" && finding.category !== category) return false;
    if (origin === "current" && finding.origin === "stored") return false;
    if (origin === "stored" && finding.origin === "current") return false;
    return (
      normalizedQuery === "" ||
      findingSearchText(finding, session.draftDocument, session.eventContexts).includes(
        normalizedQuery,
      )
    );
  });

  const groups = groupDisplayFindings(visibleFindings, session.draftDocument);
  const firstRejected = session.eventContexts.find(
    (context) =>
      !context.applied &&
      session.findings.some(
        (finding) => finding.severity === "blocking" && finding.eventId === context.eventId,
      ),
  );
  return (
    <section className="panel correction-findings">
      <div className="panel-title-row">
        <h2>현재 보정할 문제</h2>
        <span>
          {String(visibleFindings.length)} / {String(allFindings.length)}건
        </span>
      </div>
      <div className="finding-filters">
        <input
          type="search"
          value={query}
          aria-label="finding 검색"
          placeholder="메시지·코드·행 검색"
          onChange={(event) => setQuery(event.target.value)}
        />
        <select
          value={severity}
          aria-label="finding 심각도"
          onChange={(event) => setSeverity(event.target.value)}
        >
          <option value="all">모든 심각도</option>
          <option value="blocking">차단</option>
          <option value="warning">경고</option>
        </select>
        <select
          value={category}
          aria-label="finding 범주"
          onChange={(event) => setCategory(event.target.value)}
        >
          <option value="all">모든 범주</option>
          <option value="source">source</option>
          <option value="domain">domain</option>
          <option value="persistence">persistence</option>
        </select>
        <select
          value={origin}
          aria-label="finding 시점"
          onChange={(event) => setOrigin(event.target.value as "current" | "stored" | "all")}
        >
          <option value="current">현재 finding</option>
          <option value="stored">저장 당시 finding</option>
          <option value="all">현재 + 저장 당시</option>
        </select>
      </div>
      <div className="finding-list">
        {firstRejected === undefined ? null : (
          <button
            type="button"
            className="secondary-button finding-first-cause"
            onClick={() => onSelectEvent(firstRejected.eventId)}
          >
            먼저 확인할 미적용 행으로 이동
          </button>
        )}
        {groups.length > 0 ? (
          <p className="muted-text">
            같은 반이닝·검증 유형별로 묶었습니다. 각 항목의 원인은 별도로 확인하세요.
          </p>
        ) : null}
        {visibleFindings.length === 0 ? (
          <p className="muted-text">조건에 맞는 finding이 없습니다.</p>
        ) : (
          groups.map((group, index) => (
            <details
              className="finding-group"
              key={group.key}
              open={
                index === 0 || group.findings.some((finding) => finding.eventId === selectedEventId)
              }
            >
              <summary>
                {group.label} <b>{group.findings.length}건</b>
              </summary>
              {group.findings.map((finding) => {
                const record = parseOfficialRecordIdentity(finding.recordIdentity);
                const tracking = trackingCandidateForFinding(session.draftDocument, finding);
                const selected =
                  record !== null
                    ? finding.recordIdentity === selectedRecordIdentity
                    : tracking !== null
                      ? tracking.trackingId === selectedTrackingId
                      : finding.eventId === selectedEventId;
                const className = `finding-item ${finding.severity} ${selected ? "selected" : ""}`;
                const content = (
                  <FindingContents
                    finding={finding}
                    document={session.draftDocument}
                    eventContexts={session.eventContexts}
                  />
                );
                const eventId = finding.eventId;
                return record === null && tracking === null && eventId === undefined ? (
                  <article className={className} key={findingIdentity(finding)}>
                    {content}
                  </article>
                ) : (
                  <button
                    key={findingIdentity(finding)}
                    type="button"
                    className={className}
                    onClick={() => {
                      if (record !== null && finding.recordIdentity !== undefined)
                        onSelectRecord(finding.recordIdentity);
                      else if (tracking !== null) onSelectTracking(tracking.trackingId);
                      else if (eventId !== undefined) onSelectEvent(eventId);
                    }}
                  >
                    {content}
                  </button>
                );
              })}
            </details>
          ))
        )}
      </div>
    </section>
  );
}

function FindingContents({
  finding,
  document,
  eventContexts,
}: {
  readonly finding: DisplayFinding;
  readonly document: StagingGameDocumentV2;
  readonly eventContexts: readonly CorrectionEventContext[];
}): React.JSX.Element {
  const recordLabel = recordIdentityLabel(document, finding.recordIdentity);
  const tracking = trackingCandidateForFinding(document, finding);
  return (
    <>
      <span className="finding-meta">
        <b>{finding.severity === "blocking" ? "차단" : "경고"}</b>
        <i>{finding.category}</i>
        <i>{findingOriginLabel(finding.origin)}</i>
      </span>
      <strong>{finding.message}</strong>
      <span className="finding-location">
        {recordLabel ??
          (tracking === null
            ? finding.eventSequence === undefined
              ? "경기 전체"
              : `${String(finding.eventSequence + 1)}행`
            : trackingFindingLocation(document, tracking, eventContexts))}
      </span>
      {tracking === null ? (
        <FindingDetails
          code={finding.code}
          details={finding.details}
          recordIdentity={finding.recordIdentity}
        />
      ) : (
        <TrackingFindingDetails finding={finding} document={document} />
      )}
      {tracking === null ? null : (
        <span className="finding-navigation-hint">
          선택하면 관련 투구 행 또는 우측 tracking 예외를 엽니다.
        </span>
      )}
      <code>{finding.code}</code>
    </>
  );
}

function TrackingFindingDetails({
  finding,
  document,
}: {
  readonly finding: DisplayFinding;
  readonly document: StagingGameDocumentV2;
}): React.JSX.Element {
  const candidates = trackingCandidatesForFinding(document, finding);
  return (
    <ul className="finding-details tracking-finding-details">
      {candidates.map((candidate, index) => (
        <li key={candidate.trackingId}>
          후보 {String(index + 1)} · {trackingSourceLocation(candidate)}
        </li>
      ))}
    </ul>
  );
}

function findingSearchText(
  finding: DisplayFinding,
  document: StagingGameDocumentV2,
  eventContexts: readonly CorrectionEventContext[],
): string {
  const trackingCandidates = trackingCandidatesForFinding(document, finding);
  return [
    finding.message,
    finding.code,
    finding.category,
    finding.severity,
    finding.origin,
    finding.eventId ?? "",
    finding.eventSequence === undefined ? "" : String(finding.eventSequence + 1),
    finding.recordIdentity ?? "",
    recordIdentityLabel(document, finding.recordIdentity) ?? "",
    ...trackingCandidates.flatMap((candidate) => [
      trackingFindingLocation(document, candidate, eventContexts),
      trackingSourceLocation(candidate),
      candidate.sourcePitchId ?? "",
    ]),
    JSON.stringify(finding.details),
  ]
    .join(" ")
    .toLocaleLowerCase("ko-KR");
}

function findingOriginLabel(origin: DisplayFinding["origin"]): string {
  if (origin === "both") return "현재·저장 당시";
  return origin === "stored" ? "저장 당시" : "현재";
}

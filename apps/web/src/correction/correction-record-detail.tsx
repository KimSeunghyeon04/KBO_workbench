import type { CorrectionSession, StagingGameDocumentV2 } from "@kbo/contracts";
import { useMemo, useState } from "react";
import {
  buildPlayerRecordComparisons,
  recordKindLabel,
  type RecordComparisonStatus,
  type RecordKind,
} from "./record-comparison";

export function RecordDetail({
  document,
  calculatedRecords,
  kind,
  selectedRecordIdentity,
  onKindChange,
  onSelectRecord,
  onClose,
}: {
  readonly document: StagingGameDocumentV2;
  readonly calculatedRecords: CorrectionSession["calculatedRecords"];
  readonly kind: RecordKind;
  readonly selectedRecordIdentity: string | null;
  readonly onKindChange: (kind: RecordKind) => void;
  readonly onSelectRecord: (recordIdentity: string) => void;
  readonly onClose: () => void;
}): React.JSX.Element {
  const [query, setQuery] = useState("");
  const comparisons = useMemo(
    () => buildPlayerRecordComparisons(document, calculatedRecords),
    [calculatedRecords, document],
  );
  const normalizedQuery = query.trim().toLocaleLowerCase("ko-KR");
  const records = comparisons.filter(
    (record) =>
      record.kind === kind &&
      (normalizedQuery === "" ||
        [record.playerName, record.playerId, record.teamName]
          .join(" ")
          .toLocaleLowerCase("ko-KR")
          .includes(normalizedQuery)),
  );
  const selected =
    records.find((record) => record.recordIdentity === selectedRecordIdentity) ?? records[0];
  const batterCount = comparisons.filter((record) => record.kind === "batter").length;
  const pitcherCount = comparisons.filter((record) => record.kind === "pitcher").length;

  return (
    <section className="panel correction-detail correction-record-detail">
      <div className="panel-title-row">
        <h2>공식 기록 비교</h2>
        <button type="button" className="text-button" onClick={onClose}>
          원장 행 상세
        </button>
      </div>
      <div className="record-kind-tabs" role="group" aria-label="기록 종류">
        <button
          type="button"
          aria-pressed={kind === "batter"}
          onClick={() => onKindChange("batter")}
        >
          타자 {String(batterCount)}명
        </button>
        <button
          type="button"
          aria-pressed={kind === "pitcher"}
          onClick={() => onKindChange("pitcher")}
        >
          투수 {String(pitcherCount)}명
        </button>
      </div>
      <label className="record-player-filter">
        <span>선수 검색</span>
        <input
          type="search"
          value={query}
          placeholder="이름·팀·선수 ID"
          onChange={(event) => setQuery(event.target.value)}
        />
      </label>
      {records.length === 0 ? (
        <p className="muted-text record-detail-empty">
          {query.trim() === ""
            ? `${recordKindLabel(kind)} 기록이 없습니다.`
            : "검색 조건에 맞는 선수 기록이 없습니다."}
        </p>
      ) : (
        <div className="record-detail-body">
          <label className="record-player-select">
            <span>기록 선수</span>
            <select
              value={selected?.recordIdentity ?? ""}
              onChange={(event) => onSelectRecord(event.target.value)}
            >
              {records.map((record) => (
                <option key={record.recordIdentity} value={record.recordIdentity}>
                  {record.teamName} {record.playerName} ({record.playerId})
                  {record.mismatchCount > 0 ? ` · 불일치 ${String(record.mismatchCount)}` : ""}
                </option>
              ))}
            </select>
          </label>
          {selected === undefined ? null : (
            <>
              <article className="record-player-summary">
                <span>
                  {recordKindLabel(selected.kind)} · {selected.teamName}
                </span>
                <h3>{selected.playerName}</h3>
                <p>
                  {selected.battingOrder === undefined
                    ? "타순 미확인"
                    : `${String(selected.battingOrder)}번 타순`}{" "}
                  · 선수 ID {selected.playerId}
                </p>
                <b className={selected.mismatchCount > 0 ? "mismatch" : "match"}>
                  {selected.mismatchCount > 0
                    ? `불일치 ${String(selected.mismatchCount)}개`
                    : "제공된 기록 일치"}
                </b>
              </article>
              <div
                className="record-stat-table"
                role="table"
                aria-label={`${selected.playerName} 기록 비교`}
              >
                <div className="record-stat-header" role="row">
                  <span role="columnheader">항목</span>
                  <span role="columnheader">공식</span>
                  <span role="columnheader">compiler</span>
                  <span role="columnheader">판정</span>
                </div>
                {selected.fields.map((field) => (
                  <div className={`record-stat-row ${field.status}`} role="row" key={field.field}>
                    <strong role="cell">{field.label}</strong>
                    <span role="cell">{recordValue(field.official, "official")}</span>
                    <span role="cell">{recordValue(field.calculated, "calculated")}</span>
                    <em role="cell">{recordStatusLabel(field.status)}</em>
                  </div>
                ))}
              </div>
              <p className="record-comparison-note">
                공식 제공 필드만 검증합니다. compiler가 계산하지 않는 자책점은 비교에서 제외합니다.
              </p>
            </>
          )}
        </div>
      )}
    </section>
  );
}

function recordValue(value: number | null | undefined, source: "official" | "calculated"): string {
  if (value === undefined) return source === "official" ? "미제공" : "기록 없음";
  if (value === null) return "계산 제외";
  return String(value);
}

function recordStatusLabel(status: RecordComparisonStatus): string {
  if (status === "match") return "일치";
  if (status === "mismatch") return "불일치";
  if (status === "official_missing") return "공식 미제공";
  if (status === "calculated_missing") return "계산 기록 없음";
  return "검증 제외";
}

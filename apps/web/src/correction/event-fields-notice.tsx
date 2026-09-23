import { autofillReason } from "./event-editor-autofill";
import { EVENT_KINDS } from "./event-editor-registry";
import { AutofillHint, referenceEventLabel, type EventFieldProps } from "./event-field-context";
import { eventKindLabel } from "./event-presentation";
export function ReviewFields({
  form,
  assignments,
  update,
  document,
  referenceEvents,
  queuedEvents,
}: EventFieldProps): React.JSX.Element {
  return (
    <>
      <label>
        판정
        <select
          value={form.decision}
          onChange={(event) => update({ decision: event.target.value })}
        >
          <option value="">미확정</option>
          <option value="requested">요청</option>
          <option value="upheld">원심 유지</option>
          <option value="overturned">번복</option>
          <option value="inconclusive">판정 불가</option>
        </select>
      </label>
      <label>
        판독 대상 행 (선택)
        <select
          value={form.reviewedEventId}
          data-editor-field="review-reference"
          onChange={(event) => update({ reviewedEventId: event.target.value })}
        >
          <option value="">연결 없음</option>
          {referenceEvents.map((item) => (
            <option key={item.identity.eventId} value={item.identity.eventId}>
              {referenceEventLabel(document, queuedEvents, item)}
            </option>
          ))}
        </select>
        <AutofillHint reason={autofillReason(assignments, "reviewedEventId")} />
      </label>
    </>
  );
}

export function AdministrativeFields({ form, update }: EventFieldProps): React.JSX.Element {
  return (
    <label>
      안내 종류
      <select
        value={form.adminCode}
        onChange={(event) => update({ adminCode: event.target.value })}
      >
        <option value="announcement">공지</option>
        <option value="mound_visit">마운드 방문</option>
        <option value="break">휴식·중단</option>
        <option value="footer">footer</option>
        <option value="called_game">콜드게임 종료 선언</option>
        <option value="other">기타</option>
      </select>
    </label>
  );
}

export function UnresolvedFields({ form, update }: EventFieldProps): React.JSX.Element {
  return (
    <>
      <label>
        정리된 원천 타입
        <input
          value={form.sourceType}
          data-editor-field="source-type"
          onChange={(event) => update({ sourceType: event.target.value })}
        />
      </label>
      <label>
        추정 행 종류
        <select
          value={form.suspectedKind}
          onChange={(event) => update({ suspectedKind: event.target.value })}
        >
          <option value="">추정 없음</option>
          {EVENT_KINDS.filter((item) => item !== "unresolved").map((item) => (
            <option key={item} value={item}>
              {eventKindLabel(item)}
            </option>
          ))}
        </select>
      </label>
      <p className="muted-text">
        원문과 원천 위치는 유지됩니다. 종류를 바꾸면 같은 행을 typed 행으로 교체합니다.
      </p>
    </>
  );
}

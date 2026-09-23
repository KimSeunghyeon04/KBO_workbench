import { autofillReason } from "./event-editor-autofill";
import {
  PITCH_CALLS,
  PLATE_RESULTS,
  plateResultAllowsBattedBall,
  resultDefaults,
} from "./event-editor-registry";
import {
  autoHint,
  contextStateForForm,
  defaultBatterDestinationLabel,
  inheritedPlayerLabel,
  type EventFieldProps,
} from "./event-field-context";
import { PlayerPicker, playerSideForRole } from "./player-picker";
export function BatterStartFields({
  form,
  assignments,
  update,
  document,
}: EventFieldProps): React.JSX.Element {
  const batterSide = playerSideForRole(form.half, "batter");
  const pitcherSide = playerSideForRole(form.half, "pitcher");

  return (
    <>
      <PlayerPicker
        label="타자"
        helperText={autoHint(autofillReason(assignments, "batterId"))}
        document={document}
        side={batterSide}
        value={form.batterId}
        onChange={(batterId) => update({ batterId })}
      />
      <PlayerPicker
        label="투수"
        helperText={autoHint(autofillReason(assignments, "pitcherId"))}
        document={document}
        side={pitcherSide}
        value={form.pitcherId}
        onChange={(pitcherId) => update({ pitcherId })}
      />
    </>
  );
}

export function PitchFields({
  form,
  update,
  document,
  context,
}: EventFieldProps): React.JSX.Element {
  const batterSide = playerSideForRole(form.half, "batter");
  const pitcherSide = playerSideForRole(form.half, "pitcher");
  const inheritedState = contextStateForForm(form, context, context.state);

  return (
    <>
      <label>
        판정
        <select value={form.call} onChange={(event) => update({ call: event.target.value })}>
          {PITCH_CALLS.map((item) => (
            <option key={item} value={item}>
              {item.replaceAll("_", " ")}
            </option>
          ))}
        </select>
      </label>
      <label>
        구속 km/h (선택)
        <input
          type="number"
          min="0"
          step="any"
          value={form.speedKph}
          onChange={(event) => update({ speedKph: event.target.value })}
        />
      </label>
      <label>
        구종 (선택)
        <input
          value={form.pitchType}
          maxLength={100}
          onChange={(event) => update({ pitchType: event.target.value })}
        />
      </label>
      <label>
        원천 투구 ID (선택)
        <input
          value={form.sourcePitchId}
          onChange={(event) => update({ sourcePitchId: event.target.value })}
          placeholder="Naver가 제공한 경우에만"
        />
      </label>
      <PlayerPicker
        label="타자 (선택)"
        optionalLabel={inheritedPlayerLabel(document, batterSide, inheritedState?.batterId, "타자")}
        document={document}
        side={batterSide}
        value={form.batterId}
        onChange={(batterId) => update({ batterId })}
      />
      <PlayerPicker
        label="투수 (선택)"
        optionalLabel={inheritedPlayerLabel(
          document,
          pitcherSide,
          inheritedState?.pitcherId,
          "투수",
        )}
        document={document}
        side={pitcherSide}
        value={form.pitcherId}
        onChange={(pitcherId) => update({ pitcherId })}
      />
    </>
  );
}

export function PlateResultFields({
  form,
  assignments,
  update,
  document,
}: EventFieldProps): React.JSX.Element {
  const batterSide = playerSideForRole(form.half, "batter");
  const pitcherSide = playerSideForRole(form.half, "pitcher");

  return (
    <>
      <label>
        타석 결과
        <select
          value={form.result}
          onChange={(event) => update(resultDefaults(event.target.value))}
        >
          {PLATE_RESULTS.map((item) => (
            <option value={item} key={item}>
              {item}
            </option>
          ))}
        </select>
      </label>
      <PlayerPicker
        label="타자"
        helperText={autoHint(autofillReason(assignments, "batterId"))}
        document={document}
        side={batterSide}
        value={form.batterId}
        onChange={(batterId) => update({ batterId })}
      />
      <PlayerPicker
        label="투수"
        helperText={autoHint(autofillReason(assignments, "pitcherId"))}
        document={document}
        side={pitcherSide}
        value={form.pitcherId}
        onChange={(pitcherId) => update({ pitcherId })}
      />
      <div className="form-grid three">
        <label>
          타점 (선택)
          <input
            type="number"
            min="0"
            max="4"
            value={form.creditedRbi}
            onChange={(event) => update({ creditedRbi: event.target.value })}
          />
        </label>
        <label>
          직접 기록 아웃 (선택)
          <input
            type="number"
            min="0"
            max="3"
            value={form.outsRecorded}
            onChange={(event) => update({ outsRecorded: event.target.value })}
          />
        </label>
        <label>
          타자 생존 도착 베이스
          <select
            value={form.batterDestination}
            onChange={(event) => update({ batterDestination: event.target.value })}
          >
            <option value="">{defaultBatterDestinationLabel(form.result)}</option>
            <option value="1">1루</option>
            <option value="2">2루</option>
            <option value="3">3루</option>
          </select>
        </label>
      </div>
      {plateResultAllowsBattedBall(form.result) ? (
        <div className="form-grid two">
          <label>
            타구 유형
            <select
              value={form.battedBallType}
              onChange={(event) => update({ battedBallType: event.target.value })}
            >
              <option value="">미확정</option>
              <option value="ground_ball">땅볼</option>
              <option value="fly_ball">뜬공</option>
              <option value="line_drive">직선타</option>
              <option value="popup">내야 뜬공</option>
            </select>
          </label>
          <label>
            번트 여부
            <select
              value={form.isBunt}
              onChange={(event) => update({ isBunt: event.target.value })}
            >
              <option value="">미확정</option>
              <option value="false">번트 아님</option>
              <option value="true">번트</option>
            </select>
          </label>
        </div>
      ) : null}
      <p className="muted-text">
        주자 이동은 이 결과 안에 넣지 않습니다. 별도 원장 행으로 추가하고 결과에 연결하세요.
      </p>
    </>
  );
}

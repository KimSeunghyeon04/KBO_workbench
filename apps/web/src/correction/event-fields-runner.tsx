import {
  autofillReason,
  runnerBaseModel,
  runnerContextModel,
  runnerDestinationModel,
  runnerOutcomeModel,
  runnerPlayerModel,
} from "./event-editor-autofill";
import { RUNNER_OUT_KINDS, RUNNER_REASONS, type FormState } from "./event-editor-registry";
import {
  AutofillHint,
  autoHint,
  contextStateForForm,
  referenceEventLabel,
  type EventFieldProps,
} from "./event-field-context";
import { PlayerPicker, playerSideForRole } from "./player-picker";
import { runnerResponsibilityLabel } from "./runner-responsibility";
export function RunnerFields({
  form,
  assignments,
  update,
  updateModel,
  document,
  context,
  referenceEvents,
  queuedEvents,
}: EventFieldProps): React.JSX.Element {
  const batterSide = playerSideForRole(form.half, "batter");
  const pitcherSide = playerSideForRole(form.half, "pitcher");

  const runnerState = contextStateForForm(form, context, context.runnerState);
  return (
    <>
      <PlayerPicker
        label="주자"
        helperText={autoHint(autofillReason(assignments, "runnerId"))}
        document={document}
        side={batterSide}
        value={form.runnerId}
        prioritizedPlayerIds={runnerState?.bases ?? []}
        onChange={(runnerId) =>
          updateModel((current) => runnerPlayerModel(current, runnerId, context))
        }
      />
      <div className="form-grid three">
        <label>
          출발
          <select
            value={form.fromBase}
            onChange={(event) => {
              const fromBase = event.target.value;
              updateModel((current) => runnerBaseModel(current, fromBase, context));
            }}
          >
            {[1, 2, 3].map((item) => (
              <option value={item} key={item}>
                {item === 0 ? "타자" : `${String(item)}루`}
              </option>
            ))}
          </select>
          <AutofillHint reason={autofillReason(assignments, "fromBase")} />
        </label>
        <label>
          도착
          <select
            value={form.toBase}
            onChange={(event) => {
              const toBase = event.target.value;
              updateModel((current) => runnerDestinationModel(current, toBase));
            }}
          >
            {[1, 2, 3, 4].map((item) => (
              <option value={item} key={item}>
                {item === 4 ? "홈" : `${String(item)}루`}
              </option>
            ))}
          </select>
          <AutofillHint reason={autofillReason(assignments, "toBase")} />
        </label>
        <label>
          결과
          <select
            value={form.outcome}
            onChange={(event) => {
              const outcome = event.target.value;
              updateModel((current) => runnerOutcomeModel(current, outcome));
            }}
          >
            <option value="safe">진루</option>
            <option value="out">아웃</option>
            <option value="scored">득점</option>
          </select>
          <AutofillHint reason={autofillReason(assignments, "outcome")} />
        </label>
      </div>
      {form.outcome === "out" ? (
        <label>
          아웃 종류
          <select
            value={form.outKind}
            onChange={(event) => update({ outKind: event.target.value })}
          >
            {RUNNER_OUT_KINDS.map((item) => (
              <option value={item} key={item}>
                {item}
              </option>
            ))}
          </select>
        </label>
      ) : null}
      <PlayerPicker
        label="책임 투수 (선택)"
        optionalLabel={runnerResponsibilityLabel(form, context)}
        document={document}
        side={pitcherSide}
        value={form.responsiblePitcherId}
        onChange={(responsiblePitcherId) => update({ responsiblePitcherId })}
      />
      <label>
        연결 방식
        <select
          value={form.contextKind}
          onChange={(event) => {
            const contextKind = event.target.value as FormState["contextKind"];
            updateModel((current) => runnerContextModel(current, contextKind, context));
          }}
        >
          <option value="plate_result">타석 결과에 연결</option>
          <option value="independent">독립 주자 플레이</option>
        </select>
      </label>
      {form.contextKind === "plate_result" ? (
        <label>
          연결할 타석 결과
          <select
            value={form.plateResultEventId}
            data-editor-field="plate-result-reference"
            onChange={(event) => update({ plateResultEventId: event.target.value })}
          >
            <option value="">결과 선택</option>
            {referenceEvents
              .filter((item) => item.kind === "plate_result")
              .map((item) => (
                <option value={item.identity.eventId} key={item.identity.eventId}>
                  {referenceEventLabel(document, queuedEvents, item)}
                </option>
              ))}
          </select>
          <AutofillHint reason={autofillReason(assignments, "plateResultEventId")} />
        </label>
      ) : (
        <label>
          독립 사유
          <select value={form.reason} onChange={(event) => update({ reason: event.target.value })}>
            {RUNNER_REASONS.map((item) => (
              <option value={item} key={item}>
                {item}
              </option>
            ))}
          </select>
        </label>
      )}
      {form.outcome === "out" ? (
        <label className="check-row">
          <input
            type="checkbox"
            checked={form.supersedesThirdOut}
            onChange={(event) => update({ supersedesThirdOut: event.target.checked })}
          />
          제3아웃보다 득점 판정을 우선
        </label>
      ) : null}
    </>
  );
}

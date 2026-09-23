import type { Side } from "@kbo/contracts";
import {
  autofillReason,
  substitutionOutgoingModel,
  substitutionRoleModel,
  substitutionSideModel,
} from "./event-editor-autofill";
import {
  AutofillHint,
  autoHint,
  contextStateForForm,
  substitutionPriorities,
  type EventFieldProps,
} from "./event-field-context";
import { PlayerPicker } from "./player-picker";
export function SubstitutionFields({
  form,
  assignments,
  update,
  updateModel,
  document,
  context,
}: EventFieldProps): React.JSX.Element {
  const inheritedState = contextStateForForm(form, context, context.state);

  return (
    <>
      <label>
        팀
        <select
          value={form.side}
          onChange={(event) => {
            const side = event.target.value as Side;
            updateModel((current) => substitutionSideModel(current, side, context));
          }}
        >
          <option value="away">{document.teams.away.name}</option>
          <option value="home">{document.teams.home.name}</option>
        </select>
        <AutofillHint reason={autofillReason(assignments, "side")} />
      </label>
      <label>
        역할
        <select
          value={form.role}
          onChange={(event) => {
            const role = event.target.value;
            updateModel((current) => substitutionRoleModel(current, role, context));
          }}
        >
          <option value="batter">타자</option>
          <option value="runner">주자</option>
          <option value="pitcher">투수</option>
          <option value="fielder">야수</option>
        </select>
      </label>
      <PlayerPicker
        label="들어오는 선수"
        document={document}
        side={form.side}
        value={form.incomingPlayerId}
        onChange={(incomingPlayerId) => update({ incomingPlayerId })}
      />
      <PlayerPicker
        label="나가는 선수 (선택)"
        optionalLabel="없음"
        helperText={autoHint(autofillReason(assignments, "outgoingPlayerId"))}
        document={document}
        side={form.side}
        value={form.outgoingPlayerId}
        prioritizedPlayerIds={substitutionPriorities(form, inheritedState)}
        onChange={(outgoingPlayerId) =>
          updateModel((current) => substitutionOutgoingModel(current, outgoingPlayerId, context))
        }
      />
      <div className="form-grid two">
        <label>
          타순 (선택)
          <input
            type="number"
            min="1"
            max="9"
            value={form.battingOrder}
            onChange={(event) => update({ battingOrder: event.target.value })}
          />
          <AutofillHint reason={autofillReason(assignments, "battingOrder")} />
        </label>
        <label>
          수비 위치 (선택)
          <input
            value={form.fieldPosition}
            onChange={(event) => update({ fieldPosition: event.target.value })}
          />
        </label>
      </div>
    </>
  );
}

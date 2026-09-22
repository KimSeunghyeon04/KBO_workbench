import { canonicalStringify, type ObservedState, type StagingGameDocumentV2 } from "@kbo/contracts";

const NUMBER_FIELDS = [
  ["balls", "관측 볼"],
  ["strikes", "관측 스트라이크"],
  ["outs", "관측 아웃"],
  ["awayScore", "관측 원정 점수"],
  ["homeScore", "관측 홈 점수"],
] as const;
type NumberField = (typeof NUMBER_FIELDS)[number][0];
type BaseSlot = NonNullable<ObservedState["bases"]>[number];

export interface ObservedStateForm {
  readonly numbers: Readonly<Record<NumberField, string>>;
  readonly bases: readonly [string, string, string] | null;
}

function baseValue(slot: BaseSlot): string {
  return typeof slot === "string" ? `player:${slot}` : slot === true ? "occupied" : "empty";
}

export function observedStateForm(value: ObservedState | undefined): ObservedStateForm {
  return {
    numbers: {
      balls: value?.balls?.toString() ?? "",
      strikes: value?.strikes?.toString() ?? "",
      outs: value?.outs?.toString() ?? "",
      awayScore: value?.awayScore?.toString() ?? "",
      homeScore: value?.homeScore?.toString() ?? "",
    },
    bases:
      value?.bases === undefined
        ? null
        : [baseValue(value.bases[0]), baseValue(value.bases[1]), baseValue(value.bases[2])],
  };
}

export function decodeObservedStateForm(
  form: ObservedStateForm,
  original: ObservedState | undefined,
): { value: ObservedState; error: null } | { value: null; error: string } {
  const value: ObservedState = {};
  for (const [field, label] of NUMBER_FIELDS) {
    const text = form.numbers[field].trim();
    if (text === "") continue;
    const number = Number(text);
    if (!/^\d+$/.test(text) || !Number.isSafeInteger(number)) {
      return { value: null, error: `${label}은 0 이상의 정수로 입력하세요.` };
    }
    value[field] = number;
  }
  if (form.bases !== null) {
    const decodeBase = (text: string, index: number): BaseSlot => {
      const prior = original?.bases?.[index];
      // Preserve the provider's null/false distinction when this slot was not edited.
      if (prior !== undefined && baseValue(prior) === text) return prior;
      return text === "empty" ? false : text === "occupied" ? true : text.slice(7);
    };
    value.bases = [
      decodeBase(form.bases[0], 0),
      decodeBase(form.bases[1], 1),
      decodeBase(form.bases[2], 2),
    ];
  }
  return { value, error: null };
}

export function observedStateChanged(
  value: ObservedState,
  original: ObservedState | undefined,
): boolean {
  return canonicalStringify(value) !== canonicalStringify(original ?? {});
}

export function ObservedStateEditor({
  form,
  document,
  side,
  onChange,
}: {
  readonly form: ObservedStateForm;
  readonly document: StagingGameDocumentV2;
  readonly side: "away" | "home";
  readonly onChange: (form: ObservedStateForm) => void;
}): React.JSX.Element {
  const players = document.rosters[side].players;
  return (
    <details className="observed-state-editor">
      <summary>관측값 수정 (검증용)</summary>
      <p>
        원문과 대조한 뒤 잘못된 관측값만 수정하세요. 원본은 근거 패널에 보존되며, 경기 상태는 원장
        이벤트로 계산합니다.
      </p>
      <p>빈 칸은 미관측이며 0과 다릅니다. 값을 비우면 해당 항목의 비교가 생략됩니다.</p>
      <div className="form-grid two">
        {NUMBER_FIELDS.map(([field, label]) => (
          <label key={field}>
            {label}
            <input
              type="number"
              min="0"
              step="1"
              value={form.numbers[field]}
              onChange={(event) =>
                onChange({ ...form, numbers: { ...form.numbers, [field]: event.target.value } })
              }
            />
          </label>
        ))}
      </div>
      <label>
        관측 베이스 상태
        <select
          value={form.bases === null ? "unknown" : "observed"}
          onChange={(event) =>
            onChange({
              ...form,
              bases: event.target.value === "unknown" ? null : ["empty", "empty", "empty"],
            })
          }
        >
          <option value="unknown">미관측</option>
          <option value="observed">베이스별 관측 있음</option>
        </select>
      </label>
      {form.bases?.map((slot, index) => (
        <label key={index}>
          관측 {index + 1}루
          <select
            value={slot}
            onChange={(event) => {
              if (form.bases === null) return;
              const bases: [string, string, string] = [...form.bases];
              bases[index] = event.target.value;
              onChange({ ...form, bases });
            }}
          >
            <option value="empty">주자 없음</option>
            <option value="occupied">주자 있음 (선수 미상)</option>
            {players.map((player) => (
              <option key={player.playerId} value={`player:${player.playerId}`}>
                {player.name} ({player.playerId})
              </option>
            ))}
            {slot.startsWith("player:") &&
            !players.some((player) => `player:${player.playerId}` === slot) ? (
              <option value={slot}>미등록 선수 ({slot.slice(7)})</option>
            ) : null}
          </select>
        </label>
      ))}
    </details>
  );
}

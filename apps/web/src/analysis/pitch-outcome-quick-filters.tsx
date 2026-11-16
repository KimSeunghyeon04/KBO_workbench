import {
  pitchSituationConditions,
  pitchSituationKeys as conditionKeys,
  type PitchSituationKey as ConditionKey,
} from "./pitch-situation-params";

export function PitchOutcomeQuickFilters({
  params,
  onChange,
}: {
  params: URLSearchParams;
  onChange: (next: URLSearchParams) => void;
}) {
  const stance = params.get("stance");
  const balls = params.get("balls");
  const strikes = params.get("strikes");
  const active = pitchSituationConditions(params);

  const change = (updates: readonly (readonly [ConditionKey, string | null])[]) => {
    const next = new URLSearchParams(params);
    for (const [key, value] of updates) {
      if (value === null) next.delete(key);
      else next.set(key, value);
    }
    onChange(next);
  };

  return (
    <section className="outcome-quick-filters" aria-label="빠른 상황 조건">
      <div className="outcome-filter-presets" role="group" aria-label="타석 바로 선택">
        <span>타석 좌우</span>
        <button
          type="button"
          aria-pressed={stance === null}
          onClick={() => change([["stance", null]])}
        >
          전체 타석
        </button>
        <button
          type="button"
          aria-pressed={stance === "L"}
          onClick={() => change([["stance", "L"]])}
        >
          좌타자
        </button>
        <button
          type="button"
          aria-pressed={stance === "R"}
          onClick={() => change([["stance", "R"]])}
        >
          우타자
        </button>
      </div>
      <div className="outcome-filter-presets" role="group" aria-label="카운트 바로 선택">
        <span>카운트 바로 선택</span>
        <button
          type="button"
          aria-pressed={balls === null && strikes === null}
          onClick={() =>
            change([
              ["balls", null],
              ["strikes", null],
            ])
          }
        >
          전체 카운트
        </button>
        <button
          type="button"
          aria-pressed={balls === "0" && strikes === "0"}
          onClick={() =>
            change([
              ["balls", "0"],
              ["strikes", "0"],
            ])
          }
        >
          초구
        </button>
        <button
          type="button"
          aria-pressed={balls === null && strikes === "2"}
          onClick={() =>
            change([
              ["balls", null],
              ["strikes", "2"],
            ])
          }
        >
          2스트라이크
        </button>
      </div>
      <div className="outcome-active-filters" role="group" aria-label="적용된 상황 조건">
        {active.length === 0 ? (
          <span>모든 상황</span>
        ) : (
          active.map(({ key, label }) => (
            <button
              key={key}
              type="button"
              className="outcome-filter-chip"
              aria-label={`${label} 조건 해제`}
              onClick={() => change([[key, null]])}
            >
              {label} <span aria-hidden="true">×</span>
            </button>
          ))
        )}
        <button
          type="button"
          className="outcome-filter-reset"
          disabled={!conditionKeys.some((key) => params.has(key))}
          onClick={() => change(conditionKeys.map((key) => [key, null]))}
        >
          상황 조건 초기화
        </button>
      </div>
    </section>
  );
}

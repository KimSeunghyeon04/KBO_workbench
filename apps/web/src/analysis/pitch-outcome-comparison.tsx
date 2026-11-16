import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import type { PitchOutcomeQuery, PitchRateGroup } from "@kbo/contracts";
import { getBatterProfile, getPitchLocation } from "../api/pitch-outcomes-client";
import { SampleRate } from "./sample-rate";

export function previousOutcomeQuery(query: PitchOutcomeQuery): PitchOutcomeQuery {
  const previous = { ...query, season: query.season - 1 };
  delete previous.dateFrom;
  delete previous.dateTo;
  return previous;
}

const metrics = [
  { label: "Whiff%", value: "whiffRate", count: "swings", unit: "스윙" },
  { label: "CSW%", value: "cswRate", count: "pitches", unit: "구" },
  { label: "PutAway%", value: "putAwayRate", count: "twoStrikePitches", unit: "2S 공" },
] as const;

export function PitchOutcomeComparison({
  query,
  id,
  role,
  current,
}: {
  query: PitchOutcomeQuery;
  id: string;
  role: "pitcher" | "batter";
  current: PitchRateGroup;
}) {
  const [open, setOpen] = useState(false);
  const previous = previousOutcomeQuery(query);
  const result = useQuery({
    queryKey: ["pitch-outcomes", role, id, previous],
    enabled: open && query.season > 2020,
    staleTime: 60_000,
    queryFn: async ({ signal }) =>
      role === "pitcher"
        ? getPitchLocation(previous, id, signal)
        : getBatterProfile(previous, id, signal),
  });
  return (
    <section className="panel" aria-label="이전 시즌과 비교">
      <button type="button" aria-expanded={open} onClick={() => setOpen(!open)}>
        같은 선수의 이전 시즌과 비교 {open ? "접기" : "보기"}
      </button>
      {open && (
        <>
          <p>
            현재 선택 기간과 {previous.season}시즌 전체를 비교합니다. 대회·구종·카운트·타석
            좌우·표본 조건은 유지하고 날짜 제한만 해제합니다. 상대·구장 구성 차이를 조정하지 않은
            관측 비율입니다.
          </p>
          {query.season <= 2020 ? (
            <p role="status">
              이전 시즌은 수집 범위(2020–2025) 밖이므로 비교 자료를 제공하지 않습니다.
            </p>
          ) : result.isFetching ? (
            <p role="status">이전 시즌 기록을 읽고 있습니다.</p>
          ) : result.error ? (
            <p role="alert">이전 시즌 비교를 불러오지 못했습니다: {result.error.message}</p>
          ) : (
            result.data && (
              <>
                {result.data.total.pitches === 0 && (
                  <p role="status">같은 선수의 이전 시즌에 이 조건과 일치하는 투구가 없습니다.</p>
                )}
                <div className="table-scroll" tabIndex={0}>
                  <table aria-label="이전 시즌 투구 반응 비교">
                    <thead>
                      <tr>
                        <th>지표</th>
                        <th>현재 선택 기간</th>
                        <th>{previous.season}시즌 전체</th>
                      </tr>
                    </thead>
                    <tbody>
                      {metrics.map((metric) => (
                        <tr key={metric.value}>
                          <th scope="row">{metric.label}</th>
                          <td>
                            <SampleRate
                              value={current[metric.value]}
                              denominator={current[metric.count]}
                              unit={metric.unit}
                            />
                          </td>
                          <td>
                            <SampleRate
                              value={result.data.total[metric.value]}
                              denominator={result.data.total[metric.count]}
                              unit={metric.unit}
                            />
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </>
            )
          )}
        </>
      )}
    </section>
  );
}

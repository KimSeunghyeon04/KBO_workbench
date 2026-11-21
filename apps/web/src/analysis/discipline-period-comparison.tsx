import type { DisciplineResponse } from "@kbo/contracts";
import { PlayerPeriodComparison } from "./player-period-comparison";

export function DisciplinePeriodComparison({ data }: { data: DisciplineResponse }) {
  return (
    <PlayerPeriodComparison kind="batter-discipline" query={data.query} playerId={data.batterId} />
  );
}

import {
  RunExpectancyModelSchema,
  CountRunModelSchema,
  WinModelSchema,
  type RunObservation,
  type CountRunObservation,
  type WinObservation,
  type RunExpectancyModel,
  type CountRunModel,
  type WinModel,
} from "@kbo/contracts";
import { trainRunExpectancy, trainCountRunExpectancy, trainWinProbability } from "@kbo/game-core";
import { Value } from "@sinclair/typebox/value";
export type RunModelObservation =
  | { record: "pa"; value: RunObservation }
  | { record: "count"; value: CountRunObservation }
  | { record: "win"; value: WinObservation };
export interface RunModelComputation {
  kind: "run_model";
  model: "re24" | "count" | "win";
  through: number;
  sourceHash: string;
  rows: readonly RunModelObservation[];
}
export type RunModel = RunExpectancyModel | CountRunModel | WinModel;
export function computeRunModel(input: RunModelComputation): RunModel {
  const pa: RunObservation[] = [],
    counts: CountRunObservation[] = [],
    wins: WinObservation[] = [];
  for (const row of input.rows)
    if (row.record === "pa") pa.push(row.value);
    else if (row.record === "count") counts.push(row.value);
    else wins.push(row.value);
  return input.model === "count"
    ? Value.Decode(
        CountRunModelSchema,
        trainCountRunExpectancy(counts, pa, input.sourceHash, input.through),
      )
    : input.model === "win"
      ? Value.Decode(WinModelSchema, trainWinProbability(wins, input.sourceHash, input.through))
      : Value.Decode(
          RunExpectancyModelSchema,
          trainRunExpectancy(pa, input.sourceHash, input.through),
        );
}

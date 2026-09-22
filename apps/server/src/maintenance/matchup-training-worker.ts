import { parentPort, workerData } from "node:worker_threads";
import { Type } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import { Pool } from "pg";
import {
  PitchQualityRepository,
  PitchQualityWorkspace,
  pitchQualitySourceHash,
} from "@kbo/persistence";
import { trainMatchupModel } from "@kbo/game-core";
import { loadConfig } from "../config.js";
const { through, baseDirectory } = Value.Decode(
  Type.Object(
    { through: Type.Integer({ minimum: 2020, maximum: 2024 }), baseDirectory: Type.String() },
    { additionalProperties: false },
  ),
  workerData,
);
const port = parentPort;
if (port === null) throw new Error("Training requires its maintenance worker");
const base = await new PitchQualityWorkspace(baseDirectory, async () => {
  throw new Error("Read only base model");
}).read(through);
if (base === null) throw new Error("먼저 현재 원천의 구종 기대 효과 모델을 학습해야 합니다.");
const pool = new Pool({ ...loadConfig().database, max: 1 });
// Read and fit in the same maintenance worker so 1.3M raw rows are never cloned to another heap.
const input = await new PitchQualityRepository(pool).training(through).finally(() => pool.end());
const sourceHash = pitchQualitySourceHash(input.manifest);
if (base.model.sourceHash !== sourceHash)
  throw new Error("구종 기대 효과 모델과 현재 원천이 다릅니다.");
port.postMessage({ phase: "read" });
const model = trainMatchupModel(input.rows, base.model, base.hash, sourceHash);
port.postMessage({ model, manifest: input.manifest, rows: input.rows.length });

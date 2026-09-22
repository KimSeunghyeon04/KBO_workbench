import { parentPort, workerData } from "node:worker_threads";
import { PitchClusterInputSchema } from "@kbo/contracts";
import { clusterPitchPositions } from "@kbo/game-core";
import { Value } from "@sinclair/typebox/value";

const data: unknown = workerData;
const input = Value.Decode(PitchClusterInputSchema, data);
parentPort?.postMessage(clusterPitchPositions(input.points, input.componentCount));
parentPort?.close();

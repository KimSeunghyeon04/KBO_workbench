import { parentPort } from "node:worker_threads";
import {
  DisciplineSnapshotSchema,
  DisciplineQuerySchema,
  DisciplineParamsSchema,
} from "@kbo/contracts";
import {
  analyzeBatterDiscipline,
  prepareDisciplineSeason,
  type PreparedDisciplineSeason,
} from "@kbo/game-core";
import { Type } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";

const requestSchema = Type.Object(
  {
    snapshot: DisciplineSnapshotSchema,
    query: DisciplineQuerySchema,
    append: Type.Boolean(),
    complete: Type.Boolean(),
    ...DisciplineParamsSchema.properties,
  },
  { additionalProperties: false },
);
let cached:
  | {
      snapshot: PreparedDisciplineSeason["snapshot"];
      rows: PreparedDisciplineSeason["rows"][number][];
      points: PreparedDisciplineSeason["points"][number][];
    }
  | undefined;
parentPort?.on("message", (raw: unknown) => {
  const { snapshot, query, batterId, append, complete } = Value.Decode(requestSchema, raw);
  if (snapshot.rows !== null) {
    const prepared = prepareDisciplineSeason(snapshot);
    if (!append) cached = { snapshot: prepared.snapshot, rows: [], points: [] };
    if (
      cached === undefined ||
      cached.snapshot.season !== snapshot.season ||
      cached.snapshot.sourceHash !== snapshot.sourceHash
    )
      throw new Error("Discipline chunk mismatch");
    cached.rows.push(...prepared.rows);
    cached.points.push(...prepared.points);
  }
  if (
    cached === undefined ||
    cached.snapshot.season !== snapshot.season ||
    cached.snapshot.sourceHash !== snapshot.sourceHash
  )
    throw new Error("Discipline snapshot expired");
  if (complete) parentPort?.postMessage(analyzeBatterDiscipline(cached, batterId, query));
});

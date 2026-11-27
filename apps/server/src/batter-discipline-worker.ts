import { createHash } from "node:crypto";
import { gunzipSync, gzipSync } from "node:zlib";
import { parentPort } from "node:worker_threads";
import {
  DisciplineSnapshotSchema,
  DisciplineQuerySchema,
  DisciplineParamsSchema,
  DisciplinePointSchema,
  DisciplineRowSchema,
  MAX_DISCIPLINE_CACHE_BYTES,
  PITCH_ANALYSIS_MODEL_VERSION,
  PITCH_REFERENCE_VERSION,
} from "@kbo/contracts";
import {
  analyzeBatterDiscipline,
  prepareDisciplineSeason,
  type PreparedDisciplineSeason,
} from "@kbo/game-core";
import { Type, type Static } from "@sinclair/typebox";
import { TypeCompiler } from "@sinclair/typebox/compiler";

const version = 1;
const digestSize = 32;
const maxDecodedBytes = 160 * 1024 * 1024;
const strict = { additionalProperties: false };
const schema = Type.Object(
  {
    version: Type.Literal(version),
    modelVersion: Type.Literal(PITCH_ANALYSIS_MODEL_VERSION),
    referenceVersion: Type.Literal(PITCH_REFERENCE_VERSION),
    prepared: Type.Object(
      {
        snapshot: Type.Omit(DisciplineSnapshotSchema, ["rows"], strict),
        rows: Type.Array(
          Type.Pick(
            DisciplineRowSchema,
            [
              "gameDate",
              "batterId",
              "eligible",
              "balls",
              "strikes",
              "pitchType",
              "stance",
              "inZone",
              "swing",
            ],
            strict,
          ),
        ),
        points: Type.Array(
          Type.Object(
            {
              ...DisciplinePointSchema.properties,
              batterId: DisciplineRowSchema.properties.batterId,
            },
            strict,
          ),
        ),
      },
      strict,
    ),
  },
  strict,
);
const validator = TypeCompiler.Compile(schema);

function digest(payload: Uint8Array) {
  return createHash("sha256").update(payload).digest();
}

function encodeDisciplineCache(prepared: PreparedDisciplineSeason): Uint8Array | undefined {
  const json = JSON.stringify({
    version,
    modelVersion: PITCH_ANALYSIS_MODEL_VERSION,
    referenceVersion: PITCH_REFERENCE_VERSION,
    prepared,
  });
  if (Buffer.byteLength(json) > maxDecodedBytes) return undefined;
  const payload = gzipSync(json, { level: 1 });
  if (digestSize + payload.byteLength > MAX_DISCIPLINE_CACHE_BYTES) return undefined;
  return Buffer.concat([digest(payload), payload]);
}

function decodeDisciplineCache(
  bytes: Uint8Array,
  expected: Pick<PreparedDisciplineSeason["snapshot"], "season" | "sourceHash">,
): Static<typeof schema>["prepared"] | undefined {
  if (bytes.byteLength <= digestSize || bytes.byteLength > MAX_DISCIPLINE_CACHE_BYTES)
    return undefined;
  const payload = bytes.subarray(digestSize);
  if (!digest(payload).equals(bytes.subarray(0, digestSize))) return undefined;
  try {
    const raw: unknown = JSON.parse(
      gunzipSync(payload, { maxOutputLength: maxDecodedBytes }).toString("utf8"),
    );
    if (
      validator.Check(raw) &&
      raw.prepared.snapshot.season === expected.season &&
      raw.prepared.snapshot.sourceHash === expected.sourceHash
    )
      return raw.prepared;
  } catch {
    // Compressed data and parsed content can be invalid after partial or external edits.
    return undefined;
  }
  return undefined;
}

const requestSchema = Type.Object(
  {
    snapshot: DisciplineSnapshotSchema,
    query: DisciplineQuerySchema,
    append: Type.Boolean(),
    complete: Type.Boolean(),
    persist: Type.Boolean(),
    artifact: Type.Optional(Type.Uint8Array()),
    ...DisciplineParamsSchema.properties,
  },
  { additionalProperties: false },
);
const request = TypeCompiler.Compile(requestSchema);
let cached:
  | {
      snapshot: PreparedDisciplineSeason["snapshot"];
      rows: PreparedDisciplineSeason["rows"][number][];
      points: PreparedDisciplineSeason["points"][number][];
    }
  | undefined;
parentPort?.on("message", (raw: unknown) => {
  // Restore in this worker so the HTTP thread never deserializes the season.
  if (!request.Check(raw)) throw new Error("Invalid discipline request");
  const { snapshot, query, batterId, append, complete, persist, artifact } = raw;
  if (artifact !== undefined) {
    const prepared = decodeDisciplineCache(artifact, snapshot);
    if (prepared === undefined) {
      parentPort?.postMessage({ result: null });
      return;
    }
    cached = prepared;
  }
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
  if (complete) {
    const result = analyzeBatterDiscipline(cached, batterId, query);
    try {
      const encoded = persist ? encodeDisciplineCache(cached) : undefined;
      parentPort?.postMessage({ result, ...(encoded === undefined ? {} : { artifact: encoded }) });
    } catch (error: unknown) {
      parentPort?.postMessage({
        result,
        cacheError: error instanceof Error ? error.message : String(error),
      });
    }
  }
});

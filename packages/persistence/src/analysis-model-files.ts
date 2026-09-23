import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { Type, type TSchema, type Static } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import { canonicalStringify } from "@kbo/contracts";
import { atomicWrite, isMissing } from "./workspace-files.js";
const hash = (value: unknown) =>
  createHash("sha256").update(canonicalStringify(value)).digest("hex");
const pointerSchema = Type.Object(
  { hash: Type.String({ pattern: "^[a-f0-9]{64}$" }) },
  { additionalProperties: false },
);
/** Only artifact I/O is shared; every feature owns its schema and semantic validation. */
export async function writeAnalysisModelFile<S extends TSchema>(
  root: string,
  kind: string,
  through: number,
  schema: S,
  payload: Static<S>,
  assertWriter: () => Promise<void>,
  signal?: AbortSignal,
) {
  signal?.throwIfAborted();
  const decoded = Value.Decode(schema, payload),
    contents = canonicalStringify(decoded),
    contentHash = createHash("sha256").update(contents).digest("hex");
  signal?.throwIfAborted();
  await assertWriter();
  await atomicWrite(path.join(root, "analysis", kind, `${contentHash}.json`), contents);
  signal?.throwIfAborted();
  await assertWriter();
  await atomicWrite(
    path.join(root, "analysis", kind, `through-${through}.json`),
    canonicalStringify({ hash: contentHash }),
  );
  return contentHash;
}
export async function readAnalysisModelFile<S extends TSchema>(
  root: string,
  kind: string,
  through: number,
  schema: S,
): Promise<{ payload: Static<S>; hash: string } | null> {
  if (!Number.isInteger(through) || through < 2020 || through > 2024) return null;
  try {
    const pointer: unknown = JSON.parse(
      await readFile(path.join(root, "analysis", kind, `through-${through}.json`), "utf8"),
    );
    if (!Value.Check(pointerSchema, pointer)) return null;
    const payload: unknown = JSON.parse(
      await readFile(path.join(root, "analysis", kind, `${pointer.hash}.json`), "utf8"),
    );
    if (!Value.Check(schema, payload)) return null;
    try {
      if (hash(payload) !== pointer.hash) return null;
    } catch {
      return null;
    }
    return { payload, hash: pointer.hash };
  } catch (error) {
    if (isMissing(error) || error instanceof SyntaxError) return null;
    throw error;
  }
}

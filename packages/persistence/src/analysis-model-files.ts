import { createHash } from "node:crypto";
import path from "node:path";
import { Type, type TSchema, type Static } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import { canonicalStringify } from "@kbo/contracts";
import { atomicWrite } from "./workspace-files.js";
import { VerifiedJsonFiles } from "./verified-json-files.js";
const hash = (value: unknown) =>
  createHash("sha256").update(canonicalStringify(value)).digest("hex");
const pointerSchema = Type.Object(
  { hash: Type.String({ pattern: "^[a-f0-9]{64}$" }) },
  { additionalProperties: false },
);
const pointers = new VerifiedJsonFiles<typeof pointerSchema.static>(64, 64 * 1024);
const artifacts = new VerifiedJsonFiles<unknown>(16, 16 * 1024 * 1024);
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
  await atomicWrite(root, path.join(root, "analysis", kind, `${contentHash}.json`), contents);
  signal?.throwIfAborted();
  await assertWriter();
  await atomicWrite(
    root,
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
  if (!Number.isInteger(through) || through < 2020 || through > 2199) return null;
  try {
    const pointer = await pointers.read(
      path.join(root, "analysis", kind, `through-${through}.json`),
      (value) => (Value.Check(pointerSchema, value) ? value : undefined),
    );
    if (pointer === undefined) return null;
    const payload = await artifacts.read(
      path.join(root, "analysis", kind, `${pointer.hash}.json`),
      (value) => {
        if (!Value.Check(schema, value)) return undefined;
        try {
          return hash(value) === pointer.hash ? value : undefined;
        } catch {
          return undefined;
        }
      },
    );
    if (!Value.Check(schema, payload)) return null;
    return { payload, hash: pointer.hash };
  } catch (error) {
    if (error instanceof SyntaxError) return null;
    throw error;
  }
}

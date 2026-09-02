export class CanonicalJsonError extends Error {
  public constructor(
    message: string,
    public readonly path: string,
  ) {
    super(`${path}: ${message}`);
    this.name = "CanonicalJsonError";
  }
}

export function canonicalStringify(value: unknown): string {
  return serialize(value, "$", new WeakSet<object>());
}

/** ICU나 host locale에 의존하지 않는 canonical Unicode code-point 정렬이다. */
export function compareCanonicalStrings(left: string, right: string): number {
  const normalizedLeft = left.normalize("NFC");
  const normalizedRight = right.normalize("NFC");
  return normalizedLeft < normalizedRight ? -1 : normalizedLeft > normalizedRight ? 1 : 0;
}

function serialize(value: unknown, path: string, ancestors: WeakSet<object>): string {
  if (value === null) {
    return "null";
  }

  switch (typeof value) {
    case "boolean":
      return value ? "true" : "false";
    case "string":
      return JSON.stringify(value.normalize("NFC"));
    case "number":
      return serializeNumber(value, path);
    case "object":
      return serializeObject(value, path, ancestors);
    default:
      throw new CanonicalJsonError(`${typeof value} 값은 JSON으로 직렬화할 수 없습니다.`, path);
  }
}

function serializeNumber(value: number, path: string): string {
  if (!Number.isFinite(value)) {
    throw new CanonicalJsonError("유한한 숫자만 허용됩니다.", path);
  }
  if (Number.isInteger(value) && !Number.isSafeInteger(value)) {
    throw new CanonicalJsonError(
      "안전한 정수 범위를 벗어난 값은 decimal string이어야 합니다.",
      path,
    );
  }
  if (Object.is(value, -0)) {
    return "0";
  }
  return JSON.stringify(value);
}

function serializeObject(value: object, path: string, ancestors: WeakSet<object>): string {
  if (ancestors.has(value)) {
    throw new CanonicalJsonError("순환 참조는 허용되지 않습니다.", path);
  }
  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      return `[${value
        .map((item, index) => serialize(item, `${path}[${index}]`, ancestors))
        .join(",")}]`;
    }

    const prototype = Object.getPrototypeOf(value) as object | null;
    if (prototype !== Object.prototype && prototype !== null) {
      throw new CanonicalJsonError("plain object만 허용됩니다.", path);
    }
    if (Object.getOwnPropertySymbols(value).length > 0) {
      throw new CanonicalJsonError("symbol key는 허용되지 않습니다.", path);
    }

    const record = value as Record<string, unknown>;
    const normalizedKeys = new Map<string, string>();
    for (const originalKey of Object.keys(record)) {
      const normalizedKey = originalKey.normalize("NFC");
      if (normalizedKeys.has(normalizedKey)) {
        throw new CanonicalJsonError("Unicode 정규화 후 중복되는 key가 있습니다.", path);
      }
      normalizedKeys.set(normalizedKey, originalKey);
    }

    return `{${[...normalizedKeys.entries()]
      .sort(([left], [right]) => compareCanonicalStrings(left, right))
      .map(([normalizedKey, originalKey]) => {
        const item = record[originalKey];
        if (item === undefined) {
          throw new CanonicalJsonError(
            "undefined 값은 허용되지 않습니다.",
            `${path}.${originalKey}`,
          );
        }
        return `${JSON.stringify(normalizedKey)}:${serialize(item, `${path}.${originalKey}`, ancestors)}`;
      })
      .join(",")}}`;
  } finally {
    ancestors.delete(value);
  }
}

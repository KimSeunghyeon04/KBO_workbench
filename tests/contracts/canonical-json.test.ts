import { describe, expect, it } from "vitest";
import fc from "fast-check";

import { CanonicalJsonError, canonicalStringify, compareCanonicalStrings } from "@kbo/contracts";

describe("canonicalStringify", () => {
  it("object key를 코드 포인트 순으로 정렬하고 문자열을 NFC로 정규화한다", () => {
    expect(canonicalStringify({ z: 1, a: "e\u0301" })).toBe('{"a":"é","z":1}');
  });

  it("배열 순서와 -0 정규화를 보존한다", () => {
    expect(canonicalStringify([2, -0, 1])).toBe("[2,0,1]");
  });

  it("빈 배열 항목을 생략하거나 null로 바꾸지 않고 정확한 위치에서 거부한다", () => {
    const sparse = [1, 2];
    delete sparse[0];
    expect(() => canonicalStringify(sparse)).toThrow(CanonicalJsonError);
    expect(() => canonicalStringify({ values: sparse })).toThrow("$.values[0]");
    expect(() => canonicalStringify([undefined])).toThrow(CanonicalJsonError);
    expect(canonicalStringify([])).toBe("[]");
  });

  it("배열에서도 symbol key를 거부한다", () => {
    const values = [1, 2];
    Object.defineProperty(values, Symbol("hidden"), { value: 3 });
    expect(() => canonicalStringify(values)).toThrow(CanonicalJsonError);
    expect(() => canonicalStringify({ values })).toThrow("$.values");
  });

  it("정상적인 배열은 순서와 기존 canonical 바이트를 유지한다", () => {
    fc.assert(
      fc.property(
        fc.array(fc.oneof(fc.integer(), fc.string(), fc.boolean(), fc.constant(null))),
        (values) => {
          const normalized = values.map((value) =>
            typeof value === "string" ? value.normalize("NFC") : value,
          );
          expect(canonicalStringify(values)).toBe(JSON.stringify(normalized));
        },
      ),
    );
  });

  it("정규화한 key를 재사용해도 삽입 순서·결합 문자·이스케이프의 결과를 보존한다", () => {
    const keys = ["z", "a", "e\u0301", "한", "😀", "\uffff", 'a"', "a\\", "\n"];
    const expected = `{${keys
      .slice()
      .sort(compareCanonicalStrings)
      .map((key) => `${JSON.stringify(key.normalize("NFC"))}:"é"`)
      .join(",")}}`;
    fc.assert(
      fc.property(
        fc.shuffledSubarray(keys, { minLength: keys.length, maxLength: keys.length }),
        (order) => {
          expect(canonicalStringify(Object.fromEntries(order.map((key) => [key, "e\u0301"])))).toBe(
            expected,
          );
        },
      ),
    );
    expect(() => canonicalStringify({ "e\u0301": 1, é: 2 })).toThrow(CanonicalJsonError);
  });

  it("문자열 정렬도 locale 대신 NFC code-point 순서를 사용한다", () => {
    expect(["한", "A", "e\u0301", "é"].sort(compareCanonicalStrings)).toEqual([
      "A",
      "e\u0301",
      "é",
      "한",
    ]);
    expect(compareCanonicalStrings("e\u0301", "é")).toBe(0);
  });

  it.each([Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1])(
    "재현할 수 없는 숫자 %s를 거부한다",
    (value) => expect(() => canonicalStringify(value)).toThrow(CanonicalJsonError),
  );

  it("순환 참조와 undefined를 거부한다", () => {
    const cyclic: { self?: unknown } = {};
    cyclic.self = cyclic;
    expect(() => canonicalStringify(cyclic)).toThrow(CanonicalJsonError);
    expect(() => canonicalStringify({ missing: undefined })).toThrow(CanonicalJsonError);
  });
});

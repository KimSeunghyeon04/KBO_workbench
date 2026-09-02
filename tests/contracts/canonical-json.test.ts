import { describe, expect, it } from "vitest";

import { CanonicalJsonError, canonicalStringify, compareCanonicalStrings } from "@kbo/contracts";

describe("canonicalStringify", () => {
  it("object key를 코드 포인트 순으로 정렬하고 문자열을 NFC로 정규화한다", () => {
    expect(canonicalStringify({ z: 1, a: "e\u0301" })).toBe('{"a":"é","z":1}');
  });

  it("배열 순서와 -0 정규화를 보존한다", () => {
    expect(canonicalStringify([2, -0, 1])).toBe("[2,0,1]");
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

/** 요청 중복 방지 키는 보안 컨텍스트 여부와 무관하게 브라우저 난수로 만든다. */
export function createRequestKey(): string {
  if (typeof crypto.randomUUID === "function") return crypto.randomUUID();
  return Array.from(crypto.getRandomValues(new Uint8Array(16)), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}

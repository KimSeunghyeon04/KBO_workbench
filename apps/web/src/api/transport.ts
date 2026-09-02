import { ApiErrorSchema } from "@kbo/contracts";
import { Value } from "@sinclair/typebox/value";

export async function requestJson(path: string, init?: RequestInit): Promise<unknown> {
  const response = await fetch(path, {
    ...init,
    headers: {
      Accept: "application/json",
      ...(init?.body === undefined ? {} : { "Content-Type": "application/json" }),
      ...init?.headers,
    },
  });
  if (!response.ok) {
    const body = (await response.json().catch(() => null)) as unknown;
    if (Value.Check(ApiErrorSchema, body)) throw new Error(body.message);
    throw new Error(`요청에 실패했습니다 (${String(response.status)})`);
  }
  return response.json() as Promise<unknown>;
}

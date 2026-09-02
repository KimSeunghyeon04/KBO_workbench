import { ApiErrorSchema, type ApiError } from "@kbo/contracts";
import { Value } from "@sinclair/typebox/value";

export class ApiClientError extends Error {
  public constructor(
    message: string,
    public readonly status: number,
    public readonly requestId: string | null,
    public readonly code: string,
    public readonly category: ApiError["category"] | "transport",
    public readonly retryable: boolean,
    public readonly details: ApiError["details"],
  ) {
    super(message);
    this.name = "ApiClientError";
  }
}

export async function requestJson(path: string, init?: RequestInit): Promise<unknown> {
  const response = await fetch(path, {
    ...init,
    headers: {
      Accept: "application/json",
      ...(init?.body === undefined ? {} : { "Content-Type": "application/json" }),
      ...init?.headers,
    },
  });
  if (!response.ok) throw await decodeApiClientError(response);
  return response.json() as Promise<unknown>;
}

export async function requestNoContent(path: string, init?: RequestInit): Promise<void> {
  const response = await fetch(path, {
    ...init,
    headers: { Accept: "application/json", ...init?.headers },
  });
  if (!response.ok) throw await decodeApiClientError(response);
}

async function decodeApiClientError(response: Response): Promise<ApiClientError> {
  const body = (await response.json().catch(() => null)) as unknown;
  if (Value.Check(ApiErrorSchema, body)) {
    return new ApiClientError(
      body.message,
      response.status,
      body.requestId,
      body.code,
      body.category,
      body.retryable,
      body.details,
    );
  }
  return new ApiClientError(
    `요청에 실패했습니다 (${String(response.status)})`,
    response.status,
    null,
    "invalid_error_response",
    "transport",
    response.status >= 500,
    [],
  );
}

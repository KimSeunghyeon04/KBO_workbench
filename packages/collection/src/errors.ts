export class CollectionCancelledError extends Error {
  public constructor() {
    super("수집 작업이 취소되었습니다.");
    this.name = "CollectionCancelledError";
  }
}

export class NaverTransportError extends Error {
  public constructor(
    message: string,
    public override readonly cause?: unknown,
  ) {
    super(message, { cause });
    this.name = "NaverTransportError";
  }
}

export class NaverHttpError extends Error {
  public constructor(public readonly status: number) {
    super(`Naver 응답 상태가 올바르지 않습니다: ${String(status)}`);
    this.name = "NaverHttpError";
  }
}

export class NaverEndpointMissingError extends NaverHttpError {
  public constructor() {
    super(404);
    this.name = "NaverEndpointMissingError";
  }
}

export class NaverSourceFormatError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "NaverSourceFormatError";
  }
}

export function throwIfCancelled(signal: AbortSignal): void {
  if (signal.aborted) throw new CollectionCancelledError();
}

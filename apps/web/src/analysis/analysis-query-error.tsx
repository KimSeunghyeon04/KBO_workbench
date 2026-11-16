import type { PropsWithChildren } from "react";

interface AnalysisQueryRecovery {
  readonly error: Error | null;
  readonly isFetching: boolean;
  readonly refetch: () => Promise<unknown>;
}

export function AnalysisQueryError({
  queries,
  enabled = true,
  children,
}: PropsWithChildren<{
  queries: readonly AnalysisQueryRecovery[];
  enabled?: boolean;
}>) {
  const failed = queries.filter((query) => query.error !== null);
  const message = failed[0]?.error?.message;
  if (message === undefined) return null;
  const fetching = queries.some((query) => query.isFetching);

  return (
    <div className="panel" role="alert">
      <p>자료를 불러오지 못했습니다. {message}</p>
      <button
        type="button"
        className="secondary-button"
        disabled={!enabled || fetching}
        onClick={() => {
          if (!enabled || fetching) return;
          for (const query of failed) void query.refetch();
        }}
      >
        {fetching ? "다시 불러오는 중" : "다시 시도"}
      </button>
      {children}
    </div>
  );
}

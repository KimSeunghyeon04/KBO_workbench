import { ApiClientError } from "./transport";

export function retryQuery(failureCount: number, error: Error): boolean {
  return failureCount < (isStarting(error) ? 150 : 1);
}
export function retryQueryDelay(attempt: number, error: Error): number {
  return isStarting(error) ? 2_000 : Math.min(1_000 * 2 ** attempt, 30_000);
}
function isStarting(error: Error): boolean {
  return error instanceof ApiClientError && error.code === "server_initializing" && error.retryable;
}

import {
  CollectionCancelledError,
  NaverEndpointMissingError,
  NaverHttpError,
  NaverSourceFormatError,
  NaverTransportError,
  throwIfCancelled,
} from "./errors.js";
import { NaverEndpoints, type Endpoint } from "./endpoints.js";
import type { CollectedGame, JsonClient, SourceFinding } from "./types.js";

export class NaverGameCollector {
  public constructor(
    private readonly client: JsonClient,
    private readonly endpoints = new NaverEndpoints(),
    private readonly now: () => Date = () => new Date(),
  ) {}

  public async collect(gameId: string, signal: AbortSignal): Promise<CollectedGame> {
    throwIfCancelled(signal);
    const findings: SourceFinding[] = [];
    const payloads: Record<string, unknown> = {};
    const missingEndpoints: string[] = [];
    let inningCount: number;
    try {
      const summaryEndpoint = this.endpoints.relaySummary(gameId);
      const summary = await this.client.fetchJson(summaryEndpoint.url, signal);
      payloads.relay_summary = summary;
      inningCount = this.endpoints.inningCount(summary);
    } catch (error: unknown) {
      if (error instanceof CollectionCancelledError) throw error;
      return sourceFailure(gameId, sourceFindingFor(error, "relay_summary"));
    }

    for (const endpoint of this.endpoints.game(gameId, inningCount)) {
      throwIfCancelled(signal);
      try {
        payloads[endpoint.name] = await this.client.fetchJson(endpoint.url, signal);
      } catch (error: unknown) {
        if (error instanceof CollectionCancelledError) throw error;
        if (error instanceof NaverEndpointMissingError) {
          missingEndpoints.push(endpoint.name);
          findings.push({
            lifecycle: "persistent",
            code: "source.endpoint_missing",
            severity: endpoint.required ? "blocking" : "warning",
            message: `Naver 자료 항목이 누락되었습니다: ${endpoint.name}`,
            endpoint: endpoint.name,
          });
          continue;
        }
        findings.push(sourceFindingFor(error, endpoint.name));
      }
    }
    if (findings.some((finding) => finding.severity === "blocking")) {
      return { gameId, disposition: "source_failure", bundle: null, findings };
    }
    return {
      gameId,
      disposition: "collected",
      bundle: {
        gameId,
        collectedAt: this.now().toISOString(),
        payloads,
        missingEndpoints,
      },
      findings,
    };
  }
}

function sourceFailure(gameId: string, finding: SourceFinding): CollectedGame {
  return {
    gameId,
    disposition: "source_failure",
    bundle: null,
    findings: [finding],
  };
}

function sourceFindingFor(error: unknown, endpoint: Endpoint["name"]): SourceFinding {
  if (error instanceof NaverEndpointMissingError) {
    return {
      lifecycle: "persistent",
      code: "source.endpoint_missing",
      severity: "blocking",
      message: `Naver 자료 항목이 누락되었습니다: ${endpoint}`,
      endpoint,
    };
  }
  if (error instanceof NaverSourceFormatError) {
    return {
      lifecycle: "persistent",
      code: "source.shape_changed",
      severity: "blocking",
      message: error.message,
      endpoint,
    };
  }
  if (error instanceof NaverTransportError || error instanceof NaverHttpError) {
    return {
      lifecycle: "persistent",
      code: "source.transport_failure",
      severity: "blocking",
      message: error.message,
      endpoint,
    };
  }
  return {
    lifecycle: "persistent",
    code: "source.transport_failure",
    severity: "blocking",
    message: "Naver 요청 중 알 수 없는 전송 오류가 발생했습니다.",
    endpoint,
  };
}

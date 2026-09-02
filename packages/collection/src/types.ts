import type { StagingGameDocumentV2 } from "@kbo/contracts";

export interface SourceFinding {
  readonly code: string;
  readonly severity: "warning" | "blocking";
  readonly message: string;
  readonly endpoint: string | null;
  readonly eventId?: string;
  readonly blockIndex?: number;
  readonly rowIndex?: number;
  readonly sourceEventId?: string;
  readonly sourceText?: string;
}

export interface ScheduleEntry {
  readonly gameId: string;
  readonly gameDate: string;
  readonly scheduledAt: string;
  readonly label: string;
}

export interface RawGameBundle {
  readonly gameId: string;
  readonly collectedAt: string;
  readonly payloads: Readonly<Record<string, unknown>>;
  readonly missingEndpoints: readonly string[];
}

export interface MappingResult {
  readonly document: StagingGameDocumentV2;
  readonly findings: readonly SourceFinding[];
}

export interface CollectedGame {
  readonly gameId: string;
  readonly disposition: "collected" | "source_failure";
  readonly bundle: RawGameBundle | null;
  readonly findings: readonly SourceFinding[];
}

export interface ScheduleExplorer {
  discoverRange(
    startDate: string,
    endDate: string,
    signal: AbortSignal,
  ): Promise<readonly ScheduleEntry[]>;
}

export interface JsonClient {
  fetchJson(url: string, signal: AbortSignal): Promise<unknown>;
}

import type { PitchMetadata } from "@kbo/contracts";

import type { SourceFinding } from "../types.js";

export interface PitchMetadataSource {
  readonly endpoint: string;
  readonly blockIndex: number;
  readonly rowIndex: number;
  readonly eventId: string;
  readonly sourceEventId?: string;
  readonly sourceText?: string;
}

/** Provider labels remain observations; a generic fastball is not a four-seam classification. */
export function parseNaverPitchMetadata(
  speed: unknown,
  stuff: unknown,
  source: PitchMetadataSource,
): { readonly metadata: PitchMetadata; readonly findings: readonly SourceFinding[] } {
  const metadata: { speedKph?: number; pitchType?: string } = {};
  const findings: SourceFinding[] = [];
  const warn = (field: string): void => {
    findings.push({
      ...source,
      code: `source.pitch_metadata.invalid_${field}`,
      severity: "warning",
      lifecycle: "persistent",
      message: `투구 ${field} 원천값을 해석할 수 없습니다. immutable source의 해당 행을 확인하세요.`,
    });
  };
  if (!missing(speed)) {
    const numeric =
      typeof speed === "number"
        ? speed
        : typeof speed === "string" && /^\d+(?:\.\d+)?$/.test(speed.trim())
          ? Number(speed.trim())
          : NaN;
    if (Number.isFinite(numeric) && numeric > 0) metadata.speedKph = numeric;
    else warn("speed");
  }
  if (!missing(stuff)) {
    if (typeof stuff === "string" && stuff.trim().normalize("NFC").length <= 100) {
      metadata.pitchType = stuff.trim().normalize("NFC");
    } else warn("stuff");
  }
  return { metadata, findings };
}

function missing(value: unknown): boolean {
  return (
    value === undefined || value === null || (typeof value === "string" && value.trim() === "")
  );
}

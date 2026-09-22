import { describe, expect, it, vi } from "vitest";
import { createRequestKey } from "../../apps/web/src/api/request-key.js";
import { parseStagingGameDocumentV2 } from "@kbo/contracts";
import { focusedSourceEvidence } from "../../apps/web/src/correction/source-evidence-presentation.js";
import {
  groupDisplayFindings,
  type DisplayFinding,
} from "../../apps/web/src/correction/finding-presentation.js";
import { makeDocument } from "../helpers/game-document.js";

describe("보정 검토 정보", () => {
  it("randomUUID가 없는 브라우저에서도 요청 키를 생성한다", () => {
    vi.stubGlobal("crypto", { getRandomValues: (bytes: Uint8Array) => bytes.fill(17) });
    try {
      expect(createRequestKey()).toBe("11".repeat(16));
    } finally {
      vi.unstubAllGlobals();
    }
  });
  it("선택 행의 선수·카운트·주자만 먼저 보여주고 입력 원문을 변경하지 않는다", () => {
    const row = {
      text: "원정 선수 진루",
      runnerId: "a1",
      speed: "144",
      stuff: "직구",
      currentGameState: {
        bases: [{ runnerId: "a1", responsiblePitcherId: "hp1" }, null, null],
        score: { away: 1, home: 0 },
      },
      seasonStats: { hits: 120 },
    };
    const raw = JSON.stringify(row);
    expect(JSON.parse(focusedSourceEvidence(raw))).toEqual({
      text: row.text,
      runnerId: "a1",
      speed: "144",
      stuff: "직구",
      currentGameState: row.currentGameState,
    });
    expect(JSON.parse(raw)).toEqual(row);
  });
  it("같은 종류의 검증을 묶어도 독립 행과 반이닝의 근거를 각각 유지한다", () => {
    const document = parseStagingGameDocumentV2(
      makeDocument([
        { kind: "administrative", payload: { code: "announcement" } },
        { kind: "administrative", payload: { code: "announcement" } },
        { kind: "administrative", payload: { code: "announcement" }, inning: 2 },
      ]),
    );
    const findings: DisplayFinding[] = document.events.map((event) => ({
      code: "unresolved",
      category: "source",
      severity: "blocking",
      origin: "current",
      gameId: document.metadata.gameId,
      eventId: event.identity.eventId,
      eventSequence: event.sequence,
      message: "원문 확인 필요",
      details: [],
    }));
    const groups = groupDisplayFindings(findings, document);
    expect(groups.map((group) => group.findings.length)).toEqual([2, 1]);
    expect(groups.flatMap((group) => group.findings)).toEqual(findings);
  });
});

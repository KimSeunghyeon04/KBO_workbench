import { readFile } from "node:fs/promises";

import {
  KboRecordCorrectionCollector,
  normalizeKboRecordCorrectionNotice,
  parseKboRecordCorrectionControl,
  parseKboRecordCorrectionResponse,
  recordCorrectionContentHash,
  type KboRecordCorrectionRawPage,
} from "@kbo/collection";
import { describe, expect, it } from "vitest";

describe("KBO 기록정정 수집", () => {
  it("공식 control endpoint의 최상위 배열 응답을 파싱한다", () => {
    expect(
      parseKboRecordCorrectionControl([
        { value: 2024, text: 2024 },
        { value: "0", text: "KBO 정규시즌" },
      ]),
    ).toEqual([
      { value: "2024", label: "2024" },
      { value: "0", label: "KBO 정규시즌" },
    ]);
  });

  it("12열, DH, HTML 줄바꿈, 선수와 지원 밖 통계를 손실 없이 파싱한다", async () => {
    const raw = JSON.parse(
      await readFile("tests/fixtures/kbo-record-corrections/page-2024-regular-1.json", "utf8"),
    ) as unknown;
    const parsed = parseKboRecordCorrectionResponse(
      raw,
      2024,
      0,
      "정규시즌",
      "records:2024:0:1",
      0,
    );
    expect(parsed.totalCount).toBe(1);
    expect(parsed.notices[0]).toMatchObject({
      noticeId: "2024:0:1",
      doubleheaderNumber: 1,
      inning: 3,
      half: "top",
      battingOrder: 7,
      decisionBefore: "fielder_choice",
      decisionAfter: "error",
    });
    expect(parsed.notices[0]?.participants.map((item) => item.rawPlayerName)).toEqual([
      "가상야수",
      "가상타자",
      "가상투수",
    ]);
    expect(parsed.notices[0]?.participants.map((item) => item.role)).toEqual([
      "fielder",
      "batter",
      "pitcher",
    ]);
    expect(parsed.notices[0]?.statChanges).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ statCode: "total_bases", supportKind: "derived" }),
        expect.objectContaining({ statCode: "fielding_errors", supportKind: "evidence_only" }),
        expect.objectContaining({ statCode: "unknown", supportKind: "unknown" }),
      ]),
    );
  });

  it("투수 희비는 타자 희생플라이와 구분해 적용 불가능한 증거로 분류한다", async () => {
    const raw = JSON.parse(
      await readFile(
        "tests/fixtures/kbo-record-corrections/page-pitcher-sacrifice-fly.anonymized.json",
        "utf8",
      ),
    ) as unknown;
    const parsed = parseKboRecordCorrectionResponse(
      raw,
      2024,
      0,
      "비식별 정규시즌",
      "records:2024:0:1",
      0,
    );
    const sacrificeFlies = parsed.notices[0]?.statChanges.filter(
      (stat) => stat.rawStatName === "희비",
    );

    expect(sacrificeFlies).toEqual([
      expect.objectContaining({
        scope: "batter",
        statCode: "sacrifice_flies",
        supportKind: "direct",
      }),
      expect.objectContaining({
        scope: "pitcher",
        statCode: "sacrifice_flies",
        supportKind: "evidence_only",
      }),
    ]);

    const notice = parsed.notices[0];
    if (notice === undefined) throw new Error("비식별 기록정정 공지가 없습니다.");
    const staleNotice = {
      ...notice,
      statChanges: notice.statChanges.map((stat) =>
        stat.scope === "pitcher" && stat.rawStatName === "희비"
          ? { ...stat, statCode: "unknown" as const, supportKind: "unknown" as const }
          : stat,
      ),
    };
    expect(
      normalizeKboRecordCorrectionNotice(staleNotice).statChanges.find(
        (stat) => stat.scope === "pitcher" && stat.rawStatName === "희비",
      ),
    ).toMatchObject({ statCode: "sacrifice_flies", supportKind: "evidence_only" });
  });

  it("control과 모든 pagination source가 있어야 완성된 dataset을 만든다", async () => {
    const recordBody = await readFile(
      "tests/fixtures/kbo-record-corrections/page-2024-regular-1.json",
      "utf8",
    );
    const page = (body: string, second: number): KboRecordCorrectionRawPage => ({
      body,
      collectedAt: `2024-10-01T00:00:0${String(second)}.000Z`,
    });
    const client = {
      landing: async () => page("<html>fixture</html>", 0),
      years: async () => page(JSON.stringify([{ value: 2024, text: 2024 }]), 1),
      series: async () => page(JSON.stringify([{ value: "0", text: "정규시즌" }]), 2),
      records: async () => page(recordBody, 3),
    };
    const collector = new KboRecordCorrectionCollector(client);
    const result = await collector.collect({
      season: 2024,
      sink: async (input) => ({
        artifactKey: `record-corrections/source/${input.requestKey}.gz`,
        contentHash: recordCorrectionContentHash(input.body),
      }),
    });
    expect(result.dataset.notices).toHaveLength(1);
    expect(result.dataset.sourcePages.map((item) => item.pageKind).sort()).toEqual([
      "control",
      "control",
      "landing",
      "records",
    ]);
    expect(result.sourceBundleHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("중단된 run은 저장된 원문만으로 동일 bundle을 재개한다", async () => {
    const recordBody = await readFile(
      "tests/fixtures/kbo-record-corrections/page-2024-regular-1.json",
      "utf8",
    );
    const page = (body: string, second: number): KboRecordCorrectionRawPage => ({
      body,
      collectedAt: `2024-10-01T00:00:0${String(second)}.000Z`,
    });
    const source = {
      landing: async () => page("<html>fixture</html>", 0),
      years: async () => page(JSON.stringify([{ value: 2024, text: 2024 }]), 1),
      series: async () => page(JSON.stringify([{ value: "0", text: "정규시즌" }]), 2),
      records: async () => page(recordBody, 3),
    };
    const stored = new Map<
      string,
      { artifactKey: string; contentHash: string; body: string; collectedAt: string }
    >();
    const first = await new KboRecordCorrectionCollector(source).collect({
      season: 2024,
      sink: async (input) => {
        const artifact = {
          artifactKey: `record-corrections/source/${input.requestKey}.gz`,
          contentHash: recordCorrectionContentHash(input.body),
          body: input.body,
          collectedAt: input.collectedAt,
        };
        stored.set(`${input.pageKind}:${input.requestKey}`, artifact);
        return artifact;
      },
    });
    const unavailable = async (): Promise<never> => {
      throw new Error("resume 중에는 네트워크를 사용하면 안 됩니다.");
    };
    const resumed = await new KboRecordCorrectionCollector({
      landing: unavailable,
      years: unavailable,
      series: unavailable,
      records: unavailable,
    }).collect({
      season: 2024,
      cache: async (pageKind, requestKey) => stored.get(`${pageKind}:${requestKey}`) ?? null,
      sink: unavailable,
    });
    expect(resumed.sourceBundleHash).toBe(first.sourceBundleHash);
    expect(resumed.dataset).toEqual(first.dataset);
  });
});

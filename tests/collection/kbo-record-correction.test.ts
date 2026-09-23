import { readFile } from "node:fs/promises";

import {
  KboRecordCorrectionCollector,
  normalizeKboRecordCorrectionNotice,
  parseKboRecordCorrectionControl,
  parseKboRecordCorrectionResponse,
  recordCorrectionContentHash,
  type KboRecordCorrectionRawPage,
} from "@kbo/collection";
import { describe, expect, it, vi } from "vitest";

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
      noticeHash: "03c19e48a9b51f10662b115a649af3a570f7ad04b33842cb4d55b85ba89c9db9",
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
    expect(notice.noticeHash).toBe(
      "00f126a90caa15e4f57d7fa81703b522aec87a860f31c1cbce20c701f092bca1",
    );
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

  it("괄호 안 줄바꿈과 선수 통계 뒤 쉼표를 비식별 실제 공지에서 함께 파싱한다", async () => {
    const raw = JSON.parse(
      await readFile(
        "tests/fixtures/kbo-record-corrections/page-wrapped-stats.anonymized.json",
        "utf8",
      ),
    ) as unknown;
    const parsed = parseKboRecordCorrectionResponse(
      raw,
      2022,
      0,
      "비식별 정규시즌",
      "records:2022:0:1",
      3,
    );
    const notice = parsed.notices[0];
    if (notice === undefined) throw new Error("비식별 기록정정 공지가 없습니다.");
    expect(notice).toMatchObject({
      noticeId: "2022:0:5",
      sourceRequestKey: "records:2022:0:1",
      sourceRowIndex: 3,
      awayTeamName: "비식별원정",
      homeTeamName: "비식별홈",
      decisionBefore: "error",
      decisionAfter: "hit",
      contentText:
        "비식별홈\n가상타자(안타 2→3, 루타 5→6,\n타점 0→1)\n비식별원정\n가상야수(실책 1→0),\n가상구원(피안타 0→1),\n가상선발(자책점 3→5)",
    });
    expect(notice.participants.map(({ rawPlayerName, role }) => [rawPlayerName, role])).toEqual([
      ["가상타자", "batter"],
      ["가상야수", "fielder"],
      ["가상선발", "pitcher"],
      ["가상구원", "pitcher"],
    ]);
    expect(
      notice.statChanges.map((stat) => [
        notice.participants.find((p) => p.participantIndex === stat.participantIndex)
          ?.rawPlayerName,
        stat.scope,
        stat.statCode,
        stat.beforeValue,
        stat.afterValue,
        stat.supportKind,
      ]),
    ).toEqual([
      ["가상타자", "batter", "hits", 2, 3, "direct"],
      ["가상타자", "batter", "total_bases", 5, 6, "derived"],
      ["가상타자", "batter", "runs_batted_in", 0, 1, "direct"],
      ["가상야수", "fielder", "fielding_errors", 1, 0, "evidence_only"],
      ["가상구원", "pitcher", "hits_allowed", 0, 1, "direct"],
      ["가상선발", "pitcher", "earned_runs", 3, 5, "direct"],
    ]);
    expect(
      parseKboRecordCorrectionResponse(raw, 2022, 0, "비식별 정규시즌", "resumed", 3).notices[0]
        ?.noticeHash,
    ).toBe(notice.noticeHash);
  });

  it.each([
    "가상타자(안타 2→3,<br />루타 5→6,<br />타점 0→1)",
    "가상타자(<br />안타 2→3, 루타 5→6, 타점 0→1<br />)，",
    "가상타자(안타 2→3<br />，루타 5→6<br />，타점 0→1),",
  ])("명시된 괄호와 통계 구분자로만 연결된 줄을 읽는다: %s", (content) => {
    const notice = noticeFromContent(content);
    expect(notice.statChanges.map((stat) => stat.statCode)).toEqual([
      "hits",
      "total_bases",
      "runs_batted_in",
    ]);
  });

  it.each([
    "가상타자(안타 2→3,<br />타점 0→1",
    "가상타자(안타 2→3,<br />비식별원정<br />타점 0→1)",
    "가상타자(안타 2→3,<br />LG<br />타점 0→1)",
    "가상타자(안타 2→3<br />타점 0→1)",
    "가상타자(안타 2→3,<br />가상야수(실책 1→0))",
    "가상타자(안타 2→3), 가상야수(실책 1→0)",
  ])("불완전하거나 모호한 통계 그룹을 다음 선수와 연결하지 않는다: %s", (content) => {
    const notice = noticeFromContent(`${content}<br />가상구원(피안타 0→1),`);
    expect(notice.contentText).toContain("가상타자");
    expect(notice.participants[0]).toMatchObject({ rawPlayerName: "가상타자", role: "unknown" });
    expect(notice.statChanges).toEqual([
      expect.objectContaining({
        participantIndex: 1,
        scope: "pitcher",
        statCode: "hits_allowed",
        beforeValue: 0,
        afterValue: 1,
      }),
    ]);
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

  it.each([2020, 2021])(
    "공식 연도 control에 없는 %i 시즌을 빈 정상 수집으로 처리하지 않는다",
    async (season) => {
      const page = (body: string): KboRecordCorrectionRawPage => ({
        body,
        collectedAt: "2026-09-23T00:00:00.000Z",
      });
      const series = vi.fn(async () => page(JSON.stringify([{ value: "0", text: "정규시즌" }])));
      const records = vi.fn(async () =>
        page(JSON.stringify({ RESULT_CD: "100", recordTbl: { totalCnt: "0", rows: [] } })),
      );
      const collector = new KboRecordCorrectionCollector({
        landing: async () => page("<html>fixture</html>"),
        years: async () =>
          page(
            JSON.stringify([2026, 2025, 2024, 2023, 2022].map((value) => ({ value, text: value }))),
          ),
        series,
        records,
      });
      await expect(
        collector.collect({
          season,
          sink: async (input) => ({
            artifactKey: `record-corrections/source/${input.requestKey}.gz`,
            contentHash: recordCorrectionContentHash(input.body),
          }),
        }),
      ).rejects.toThrow(`KBO 기록정정 control에 ${String(season)} 시즌이 없습니다.`);
      expect(series).not.toHaveBeenCalled();
      expect(records).not.toHaveBeenCalled();
    },
  );

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

function noticeFromContent(content: string) {
  const raw = {
    RESULT_CD: "100",
    recordTbl: {
      totalCnt: "1",
      rows: [
        {
          row: [
            "1",
            "07.30",
            "토",
            "비식별원정:비식별홈",
            "비식별구장",
            "6말",
            "2",
            "가상타자<br />(가상구원)",
            "실책",
            "안타",
            content,
            "08.05",
          ].map((Text) => ({ Text })),
        },
      ],
    },
  };
  const notice = parseKboRecordCorrectionResponse(raw, 2022, 0, "정규시즌", "fixture", 0)
    .notices[0];
  if (notice === undefined) throw new Error("비식별 기록정정 공지가 없습니다.");
  return notice;
}

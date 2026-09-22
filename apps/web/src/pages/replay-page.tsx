import { WinProbabilityPanel } from "../analysis/win-probability-panel";
import { CountRunValuePanel } from "../analysis/count-run-value-panel";
import { RunValuePanel } from "../analysis/run-value-panel";
import type {
  ReplayFielder,
  ReplayFrame,
  ReplayManifest,
  ReplayRunnerMovement,
  ReplayState,
  ReplayTrackingCandidate,
} from "@kbo/contracts";

import { REPLAY_SPEEDS, strikeZonePlot, type StrikeZonePlot } from "../replay/playback";
import { GamePicker } from "../replay/replay-game-picker";
import { useReplayPageController } from "../replay/use-replay-page-controller";

export function ReplayPage(): React.JSX.Element {
  const {
    games,
    stored,
    search,
    setSearch,
    gameId,
    setGameId,
    revision,
    setRevision,
    revisions,
    replay,
    index,
    setIndex,
    playing,
    setPlaying,
    speed,
    setSpeed,
    sourceOpen,
    setSourceOpen,
    seasonFilter,
    setSeasonFilter,
    selectedDate,
    setSelectedDate,
    visibleMonth,
    setVisibleMonth,
    searchInputRef,
    seasons,
    calendarMonths,
    filteredGames,
    selectedGame,
    loadedReplay,
    loadSelectedReplay,
    frame,
    state,
  } = useReplayPageController();
  return (
    <div className="page-stack replay-page">
      <header className="page-header">
        <div>
          <h1>경기 재생</h1>
          <p>DB에 materialize된 원자적 play를 한 frame씩 재생합니다.</p>
        </div>
        {loadedReplay === undefined ? null : (
          <span className="status-badge healthy">
            revision {String(loadedReplay.manifest.revision)}
          </span>
        )}
      </header>

      <section
        className={`panel replay-source-bar${loadedReplay === undefined ? "" : " compact"}`}
        aria-busy={replay.isPending}
      >
        {loadedReplay === undefined ? null : (
          <div className="replay-source-toolbar">
            <ReplaySummary manifest={loadedReplay.manifest} />
            <button
              type="button"
              className="secondary-button"
              aria-expanded={sourceOpen}
              onClick={() => setSourceOpen((current) => !current)}
            >
              {sourceOpen ? "선택 닫기" : "경기 변경"}
            </button>
          </div>
        )}
        {loadedReplay === undefined || sourceOpen ? (
          <GamePicker
            games={stored}
            filteredGames={filteredGames}
            seasons={seasons}
            seasonFilter={seasonFilter}
            calendarMonths={calendarMonths}
            visibleMonth={visibleMonth}
            selectedDate={selectedDate}
            search={search}
            searchInputRef={searchInputRef}
            selectedGame={selectedGame}
            revision={revision}
            revisions={revisions.data?.revisions ?? []}
            loadingGames={games.isPending}
            loadingRevisions={revisions.isPending}
            loadingReplay={replay.isPending}
            floating={loadedReplay !== undefined}
            onSearchChange={setSearch}
            onSeasonChange={setSeasonFilter}
            onMonthChange={setVisibleMonth}
            onDateChange={setSelectedDate}
            onGameChange={setGameId}
            onRevisionChange={setRevision}
            onClose={() => setSourceOpen(false)}
            onLoad={loadSelectedReplay}
          />
        ) : null}
      </section>

      {games.error !== null ? <div className="error-panel">{games.error.message}</div> : null}
      {revisions.error !== null ? (
        <div className="error-panel">{revisions.error.message}</div>
      ) : null}
      {replay.error !== null ? <div className="error-panel">{replay.error.message}</div> : null}

      {loadedReplay === undefined ? (
        <ReplayEmptyState
          loadingGames={games.isPending}
          storedCount={stored.length}
          sourceReady={gameId !== "" && revision !== null}
          loadingReplay={replay.isPending}
        />
      ) : (
        <>
          <Scoreboard manifest={loadedReplay.manifest} state={state} />
          <PlaybackControls
            frameCount={loadedReplay.frames.length}
            index={index}
            playing={playing}
            speed={speed}
            onIndexChange={(next) => {
              setPlaying(false);
              setIndex(next);
            }}
            onPlayingChange={setPlaying}
            onSpeedChange={setSpeed}
          />
          <div className="replay-dashboard">
            <FrameView frame={frame} />
            <StateView state={state} frame={frame} />
            <TrackingView frame={frame} />
          </div>
          {[RunValuePanel, CountRunValuePanel, WinProbabilityPanel].map((Panel, panelIndex) => (
            <Panel
              key={`${loadedReplay.manifest.gameId}-${loadedReplay.manifest.revision}-${panelIndex}`}
              manifest={loadedReplay.manifest}
              onSelect={(playId) => {
                const next = loadedReplay.frames.findIndex((p) => p.playId === playId);
                if (next >= 0) {
                  setPlaying(false);
                  setIndex(next);
                }
              }}
            />
          ))}
        </>
      )}
    </div>
  );
}

function ReplaySummary({ manifest }: { readonly manifest: ReplayManifest }): React.JSX.Element {
  return (
    <div className="replay-source-note" aria-label="불러온 경기 요약">
      <strong>
        {manifest.teams.away.name} vs {manifest.teams.home.name}
      </strong>
      <span>{formatGameDate(manifest.gameDate)}</span>
      <span>{gameStatusLabel(manifest.status)}</span>
      <span>frame {String(manifest.frameCount)}</span>
      <span>tracking {String(manifest.trackingCount)}</span>
      {manifest.warningCount > 0 ? <span>경고 {String(manifest.warningCount)}</span> : null}
      {manifest.unlinkedTracking.length > 0 ? (
        <span>미연결 tracking {String(manifest.unlinkedTracking.length)}</span>
      ) : null}
    </div>
  );
}

function ReplayEmptyState({
  loadingGames,
  storedCount,
  sourceReady,
  loadingReplay,
}: {
  readonly loadingGames: boolean;
  readonly storedCount: number;
  readonly sourceReady: boolean;
  readonly loadingReplay: boolean;
}): React.JSX.Element {
  let message = "DB 경기와 revision을 선택하세요.";
  if (loadingGames) message = "DB 경기 목록을 불러오는 중입니다.";
  else if (storedCount === 0) message = "재생할 seal된 DB 경기가 없습니다.";
  else if (loadingReplay) message = "manifest와 모든 replay frame을 검증하는 중입니다.";
  else if (sourceReady) message = "재생 불러오기를 눌러 frame을 준비하세요.";
  return (
    <section className="panel replay-empty" role="status">
      {message}
    </section>
  );
}

function Scoreboard({
  manifest,
  state,
}: {
  readonly manifest: ReplayManifest;
  readonly state: ReplayState | null;
}): React.JSX.Element {
  const occupiedBaseCount = state?.bases.filter((base) => base !== null).length ?? 0;
  return (
    <section className="panel replay-scoreboard" aria-label="경기 상황판">
      <div className="scoreboard-scoreline">
        <div className="score-team">
          <span>원정</span>
          <strong>{manifest.teams.away.name}</strong>
          <b>{String(state?.awayScore ?? 0)}</b>
        </div>
        <div className="inning-cell">
          <span className="inning-arrow" aria-hidden="true">
            {state?.half === "bottom" ? "▼" : "▲"}
          </span>
          <strong>
            {state === null || state.inning === 0 ? "-" : `${String(state.inning)}회`}
          </strong>
          <span>{state?.half === "top" ? "초" : "말"}</span>
        </div>
        <div className="score-team home">
          <span>홈</span>
          <strong>{manifest.teams.home.name}</strong>
          <b>{String(state?.homeScore ?? 0)}</b>
        </div>
      </div>
      <div className="scoreboard-live-state">
        {state === null ? (
          <div className="scoreboard-diamond-empty">상태 없음</div>
        ) : (
          <BaseDiamond state={state} compact />
        )}
        <div className="scoreboard-matchup">
          <div>
            <span>투수</span>
            <strong>{state?.pitcher?.name ?? "없음"}</strong>
          </div>
          <i aria-hidden="true">VS</i>
          <div>
            <span>타자</span>
            <strong>{state?.batter?.name ?? "없음"}</strong>
          </div>
          <p>
            <span>PA {String(state?.plateAppearance?.actualPitchCount ?? 0)}구</span>
            <span>주자 {String(occupiedBaseCount)}명</span>
          </p>
        </div>
        <CountLights state={state} />
      </div>
    </section>
  );
}

function CountLights({ state }: { readonly state: ReplayState | null }): React.JSX.Element {
  const balls = state?.balls ?? 0;
  const strikes = state?.strikes ?? 0;
  const outs = state?.outs ?? 0;
  return (
    <div
      className="count-lights"
      role="img"
      aria-label={`볼 ${String(balls)}, 스트라이크 ${String(strikes)}, 아웃 ${String(outs)}`}
    >
      <CountLightRow label="B" count={balls} maximum={3} tone="ball" />
      <CountLightRow label="S" count={strikes} maximum={2} tone="strike" />
      <CountLightRow label="O" count={outs} maximum={2} tone="out" />
    </div>
  );
}

function CountLightRow({
  label,
  count,
  maximum,
  tone,
}: {
  readonly label: string;
  readonly count: number;
  readonly maximum: number;
  readonly tone: "ball" | "strike" | "out";
}): React.JSX.Element {
  return (
    <div aria-hidden="true">
      <span>{label}</span>
      {Array.from({ length: maximum }, (_, index) => (
        <i key={index} className={index < count ? `active ${tone}` : ""} />
      ))}
    </div>
  );
}

function PlaybackControls({
  frameCount,
  index,
  playing,
  speed,
  onIndexChange,
  onPlayingChange,
  onSpeedChange,
}: {
  readonly frameCount: number;
  readonly index: number;
  readonly playing: boolean;
  readonly speed: number;
  readonly onIndexChange: (index: number) => void;
  readonly onPlayingChange: (playing: boolean) => void;
  readonly onSpeedChange: (speed: number) => void;
}): React.JSX.Element {
  const lastIndex = frameCount - 1;
  const frameLabel = `${index < 0 ? "0" : String(index + 1)} / ${String(frameCount)}`;
  return (
    <section className="panel playback-controls" aria-label="재생 제어">
      <div className="playback-buttons">
        <button
          type="button"
          aria-label="처음"
          disabled={index <= 0}
          onClick={() => onIndexChange(0)}
        >
          <span aria-hidden="true">↤</span>
          <small>처음</small>
        </button>
        <button
          type="button"
          aria-label="이전"
          disabled={index <= 0}
          onClick={() => onIndexChange(Math.max(0, index - 1))}
        >
          <span aria-hidden="true">‹</span>
          <small>이전</small>
        </button>
        <button
          className="play-button"
          type="button"
          aria-label={playing ? "일시정지" : "재생"}
          aria-pressed={playing}
          disabled={frameCount === 0}
          onClick={() => {
            if (playing) {
              onPlayingChange(false);
              return;
            }
            if (index < 0 || index >= lastIndex) onIndexChange(0);
            onPlayingChange(true);
          }}
        >
          <span aria-hidden="true">{playing ? "Ⅱ" : "▶"}</span>
          <small>{playing ? "일시정지" : "재생"}</small>
        </button>
        <button
          type="button"
          aria-label="다음"
          disabled={index < 0 || index >= lastIndex}
          onClick={() => onIndexChange(Math.min(lastIndex, index + 1))}
        >
          <span aria-hidden="true">›</span>
          <small>다음</small>
        </button>
        <button
          type="button"
          aria-label="끝"
          disabled={index < 0 || index >= lastIndex}
          onClick={() => onIndexChange(lastIndex)}
        >
          <span aria-hidden="true">↦</span>
          <small>끝</small>
        </button>
      </div>
      <label className="playback-speed">
        <span>속도</span>
        <select value={speed} onChange={(event) => onSpeedChange(Number(event.target.value))}>
          {REPLAY_SPEEDS.map((value) => (
            <option key={value} value={value}>
              {String(value)}×
            </option>
          ))}
        </select>
      </label>
      <label className="replay-scrubber">
        <span className="sr-only">재생 위치</span>
        <input
          type="range"
          min="0"
          max={Math.max(0, lastIndex)}
          value={Math.max(0, index)}
          disabled={frameCount === 0}
          aria-valuetext={frameLabel}
          onChange={(event) => onIndexChange(Number(event.target.value))}
        />
      </label>
      <span className="replay-frame-position" role="status" aria-live="polite">
        {frameLabel}
      </span>
    </section>
  );
}

function FrameView({ frame }: { readonly frame: ReplayFrame | null }): React.JSX.Element {
  return (
    <section className="panel replay-state-panel">
      <div className="panel-title-row">
        <h2>원자적 플레이</h2>
        <span>{frame === null ? "-" : `#${String(frame.playNumber)}`}</span>
      </div>
      {frame === null ? (
        <p className="muted-text replay-panel-empty">재생 frame이 없습니다.</p>
      ) : (
        <>
          <div className="selected-event-card">
            <span className={`play-kind-mark kind-${frame.kind}`} aria-hidden="true">
              {kindMark(frame.kind)}
            </span>
            <div>
              <small>
                {String(frame.inning)}회{frame.half === "top" ? "초" : "말"} ·{" "}
                {kindLabel(frame.kind)}
              </small>
              <strong>
                {frame.relayEvents
                  .map((item) => item.relayText ?? kindLabel(item.kind))
                  .join(" / ")}
              </strong>
            </div>
            <span className={frame.applied ? "applied" : "blocked"}>
              {frame.applied ? "상태에 원자적으로 적용됨" : "compile에서 적용 차단됨"}
            </span>
          </div>
          <ol className="replay-relay-rows">
            {frame.relayEvents.map((item) => (
              <li key={item.eventId}>
                <small>
                  원장 #{String(item.sequence + 1)} · {kindLabel(item.kind)}
                </small>
                <span>
                  {item.relayText ?? "원문 없음"}
                  {item.kind === "pitch" ? (
                    <small>
                      {" "}
                      · {item.pitch?.pitchType ?? "구종 미제공"} ·{" "}
                      {item.pitch?.speedKph === undefined
                        ? "구속 미제공"
                        : String(item.pitch.speedKph) + " km/h"}
                    </small>
                  ) : null}
                </span>
              </li>
            ))}
          </ol>
          {frame.movements.length > 0 ? <MovementList movements={frame.movements} /> : null}
        </>
      )}
    </section>
  );
}

function MovementList({
  movements,
}: {
  readonly movements: readonly ReplayRunnerMovement[];
}): React.JSX.Element {
  return (
    <div className="movement-block">
      <h3>주자 이동</h3>
      <ul className="replay-movement-list">
        {movements.map((movement) => (
          <li key={movement.movementId} className={`movement-${movement.outcome}`}>
            <div className="movement-card-heading">
              <strong>{movement.runner.name}</strong>
              <span>{movementOutcomeLabel(movement)}</span>
            </div>
            <div
              className="movement-route"
              role="img"
              aria-label={`${movement.runner.name}: ${baseLabel(movement.fromBase)}에서 ${baseLabel(movement.toBase)}, ${movementOutcomeLabel(movement)}`}
            >
              <span className="movement-base from">
                <i aria-hidden="true" />
                {baseLabel(movement.fromBase)}
              </span>
              <span className="movement-track" aria-hidden="true">
                <i />
                <b>→</b>
              </span>
              <span className="movement-base to">
                <i aria-hidden="true" />
                {baseLabel(movement.toBase)}
              </span>
            </div>
            <small>
              책임 투수 {movement.responsiblePitcher.name} ·{" "}
              {movement.derived ? "결과에서 파생" : "원장 기록"}
              {movement.supersedesThirdOut === true ? " · 제4아웃 우선 적용" : ""}
            </small>
          </li>
        ))}
      </ul>
    </div>
  );
}

function StateView({
  state,
  frame,
}: {
  readonly state: ReplayState | null;
  readonly frame: ReplayFrame | null;
}): React.JSX.Element {
  return (
    <section className="panel replay-state-panel">
      <div className="panel-title-row">
        <h2>플레이 후 상태</h2>
      </div>
      {state === null ? (
        <p className="muted-text replay-panel-empty">상태 없음</p>
      ) : (
        <>
          <div className="state-transition" aria-label="플레이 전후 상태">
            <div>
              <span>BEFORE</span>
              <strong>{frame === null ? "-" : stateText(frame.before)}</strong>
            </div>
            <i aria-hidden="true">→</i>
            <div className="current">
              <span>AFTER</span>
              <strong>{frame === null ? stateText(state) : stateText(frame.after)}</strong>
            </div>
          </div>
          <div className="fielder-block">
            <h3>현재 수비진</h3>
            {frame === null || frame.fielders.length === 0 ? (
              <p className="muted-text">수비 선수 정보가 없습니다.</p>
            ) : (
              <DefensiveField fielders={frame.fielders} />
            )}
          </div>
        </>
      )}
    </section>
  );
}

function BaseDiamond({
  state,
  compact = false,
}: {
  readonly state: ReplayState;
  readonly compact?: boolean;
}): React.JSX.Element {
  const occupied = state.bases
    .map((base, index) =>
      base === null
        ? null
        : `${String(index + 1)}루 ${base.runner.name}, 책임 투수 ${base.responsiblePitcher.name}`,
    )
    .filter((value): value is string => value !== null);
  return (
    <div
      className={`base-diamond${compact ? " compact" : ""}`}
      role="img"
      aria-label={occupied.length === 0 ? "주자 없음" : occupied.join("; ")}
    >
      {state.bases.map((base, index) => (
        <div
          key={index}
          className={`base-marker ${baseClass(index)}${base === null ? "" : " occupied"}`}
          aria-hidden="true"
        >
          <i />
          <small>{base?.runner.name ?? `${String(index + 1)}루`}</small>
        </div>
      ))}
      <span className="home-plate" aria-hidden="true">
        홈
      </span>
    </div>
  );
}

function DefensiveField({
  fielders,
}: {
  readonly fielders: readonly ReplayFielder[];
}): React.JSX.Element {
  const placedPlayerIds = new Set<string>();
  const assignments = DEFENSE_SLOTS.map((slot) => {
    const fielder = fielders.find(
      (candidate) =>
        !placedPlayerIds.has(candidate.player.playerId) &&
        candidate.positions.some((position) => slot.matches(position)),
    );
    if (fielder !== undefined) placedPlayerIds.add(fielder.player.playerId);
    return { ...slot, fielder };
  });
  const extras = fielders.filter((fielder) => !placedPlayerIds.has(fielder.player.playerId));
  const alignmentLabel = assignments
    .filter((assignment) => assignment.fielder !== undefined)
    .map((assignment) => `${assignment.label} ${assignment.fielder?.player.name ?? ""}`)
    .join(", ");
  return (
    <div className="defensive-alignment">
      <div
        className="defense-field"
        role="img"
        aria-label={alignmentLabel === "" ? "수비 배치 정보 없음" : `수비 배치: ${alignmentLabel}`}
      >
        <span className="field-cutout" aria-hidden="true" />
        {assignments.map((assignment) => (
          <span
            key={assignment.key}
            className={`defense-player ${assignment.key}${assignment.fielder === undefined ? " empty" : ""}`}
            aria-hidden="true"
          >
            <b>{assignment.shortLabel}</b>
            <small>{assignment.fielder?.player.name ?? "—"}</small>
          </span>
        ))}
      </div>
      {extras.length === 0 ? null : (
        <div className="defense-extras">
          {extras.map((fielder) => (
            <span key={fielder.player.playerId}>
              <b>{fielder.positions.join("/") || "기타"}</b> {fielder.player.name}
            </span>
          ))}
        </div>
      )}
    </div>
  );
}

function TrackingView({ frame }: { readonly frame: ReplayFrame | null }): React.JSX.Element {
  return (
    <section className="panel replay-tracking-detail">
      <div className="panel-title-row">
        <h2>Tracking</h2>
        <span>{String(frame?.tracking.length ?? 0)}건</span>
      </div>
      {frame === null || frame.tracking.length === 0 ? (
        <p className="muted-text tracking-empty">현재 frame에 연결된 tracking 관측이 없습니다.</p>
      ) : (
        <div className="tracking-list">
          {frame.tracking.map((observation, index) => (
            <TrackingCandidateView
              key={observation.trackingId}
              observation={observation}
              index={index}
            />
          ))}
        </div>
      )}
    </section>
  );
}

function TrackingCandidateView({
  observation,
  index,
}: {
  readonly observation: ReplayTrackingCandidate;
  readonly index: number;
}): React.JSX.Element {
  const plot = strikeZonePlot(observation);
  const metrics = trackingMetricEntries(observation);
  return (
    <article>
      <header>
        <div>
          <strong>관측 {String(index + 1)}</strong>
          <span className="mono-text">pitch {observation.sourcePitchId}</span>
        </div>
        <small>{formatObservedAt(observation.observedAt)}</small>
      </header>
      <p className="tracking-matchup">
        투수 {observation.pitcher?.name ?? "미상"} · 타자 {observation.batter?.name ?? "미상"}
      </p>
      <div className="tracking-observation-grid">
        {plot === null ? (
          <div className="tracking-plot-empty">
            타자 키 또는 투구 좌표가 없어 스트라이크존을 계산할 수 없습니다.
          </div>
        ) : (
          <StrikeZone plot={plot} />
        )}
        <MetricList metrics={metrics} />
      </div>
    </article>
  );
}

function StrikeZone({ plot }: { readonly plot: StrikeZonePlot }): React.JSX.Element {
  const width = 300;
  const height = 260;
  const padding = { top: 18, right: 18, bottom: 26, left: 28 };
  const horizontalLimit = Math.max(2.5, Math.ceil((Math.abs(plot.xFeet) + 0.25) * 2) / 2);
  const minimumZ = Math.min(0, Math.floor((plot.zFeet - 0.25) * 2) / 2);
  const maximumZ = Math.max(5, Math.ceil((plot.zFeet + 0.25) * 2) / 2);
  const innerWidth = width - padding.left - padding.right;
  const innerHeight = height - padding.top - padding.bottom;
  const x = (value: number): number =>
    padding.left + ((value + horizontalLimit) / (horizontalLimit * 2)) * innerWidth;
  const y = (value: number): number =>
    padding.top + ((maximumZ - value) / (maximumZ - minimumZ)) * innerHeight;
  const zoneHalfWidthFeet = plot.halfWidthFeet;
  const zoneLeft = x(-zoneHalfWidthFeet);
  const zoneRight = x(zoneHalfWidthFeet);
  const pointX = x(plot.xFeet);
  const pointY = y(plot.zFeet);
  return (
    <figure className="strike-zone-wrap">
      <span>포수 시점 스트라이크존</span>
      <svg
        viewBox={`0 0 ${String(width)} ${String(height)}`}
        role="img"
        aria-label={`홈플레이트 통과 위치 가로 ${plot.xFeet.toFixed(2)}피트, 높이 ${plot.zFeet.toFixed(2)}피트`}
      >
        <line x1={x(0)} y1={padding.top} x2={x(0)} y2={height - padding.bottom} />
        {[1, 2, 3, 4].map((value) => (
          <line
            key={value}
            x1={padding.left}
            y1={y(value)}
            x2={width - padding.right}
            y2={y(value)}
          />
        ))}
        <rect
          className="strike-zone-box"
          x={zoneLeft}
          y={y(plot.topFeet)}
          width={zoneRight - zoneLeft}
          height={y(plot.bottomFeet) - y(plot.topFeet)}
        />
        <circle cx={pointX} cy={pointY} r="8" />
        <text x={pointX} y={pointY + 3} textAnchor="middle">
          1
        </text>
      </svg>
      <figcaption>
        x {plot.xFeet.toFixed(2)} ft · z {plot.zFeet.toFixed(2)} ft · zone{" "}
        {plot.bottomFeet.toFixed(2)}–{plot.topFeet.toFixed(2)} ft
      </figcaption>
    </figure>
  );
}

function MetricList({
  metrics,
}: {
  readonly metrics: readonly TrackingMetricEntry[];
}): React.JSX.Element {
  return (
    <dl className="tracking-metrics">
      {metrics.map((metric) => (
        <div key={metric.key}>
          <dt>{metric.key}</dt>
          <dd>{formatMetricValue(metric.value)}</dd>
        </div>
      ))}
    </dl>
  );
}

interface TrackingMetricEntry {
  readonly key: string;
  readonly value: string | number | null;
}

function trackingMetricEntries(observation: ReplayTrackingCandidate): TrackingMetricEntry[] {
  return [
    ["stance", observation.stance],
    ["x0", observation.x0],
    ["y0", observation.y0],
    ["z0", observation.z0],
    ["vx0", observation.vx0],
    ["vy0", observation.vy0],
    ["vz0", observation.vz0],
    ["ax", observation.ax],
    ["ay", observation.ay],
    ["az", observation.az],
    ["crossPlateX", observation.crossPlateX],
    ["crossPlateY", observation.crossPlateY],
    ["존 기준 연도", observation.strikeZone?.ruleYear ?? null],
    ["타자 키 (cm)", observation.strikeZone?.batterHeightCm ?? null],
  ].map(([key, value]) => ({ key: String(key), value: value as string | number | null }));
}

const DEFENSE_SLOTS = [
  {
    key: "left-field",
    label: "좌익수",
    shortLabel: "LF",
    matches: (position: string) => position === "좌익수",
  },
  {
    key: "center-field",
    label: "중견수",
    shortLabel: "CF",
    matches: (position: string) => position === "중견수",
  },
  {
    key: "right-field",
    label: "우익수",
    shortLabel: "RF",
    matches: (position: string) => position === "우익수",
  },
  {
    key: "third-base",
    label: "3루수",
    shortLabel: "3B",
    matches: (position: string) => position === "3루수",
  },
  {
    key: "shortstop",
    label: "유격수",
    shortLabel: "SS",
    matches: (position: string) => position === "유격수",
  },
  {
    key: "second-base",
    label: "2루수",
    shortLabel: "2B",
    matches: (position: string) => position === "2루수",
  },
  {
    key: "first-base",
    label: "1루수",
    shortLabel: "1B",
    matches: (position: string) => position === "1루수",
  },
  {
    key: "pitcher",
    label: "투수",
    shortLabel: "P",
    matches: (position: string) => position.includes("투수"),
  },
  {
    key: "catcher",
    label: "포수",
    shortLabel: "C",
    matches: (position: string) => position === "포수",
  },
] as const;

function stateText(state: ReplayState): string {
  return `O${String(state.outs)} · ${String(state.awayScore)}:${String(state.homeScore)}`;
}

function baseClass(index: number): "first" | "second" | "third" {
  if (index === 0) return "first";
  if (index === 1) return "second";
  return "third";
}

function baseLabel(base: number): string {
  return base === 0 ? "타석" : base === 4 ? "홈" : `${String(base)}루`;
}

function movementOutcomeLabel(movement: ReplayRunnerMovement): string {
  if (movement.outcome === "safe") return "세이프";
  if (movement.outcome === "scored") return "득점";
  return movement.outKind === null ? "아웃" : `아웃 · ${outKindLabel(movement.outKind)}`;
}

function outKindLabel(kind: NonNullable<ReplayRunnerMovement["outKind"]>): string {
  return {
    force: "포스 아웃",
    tag: "태그 아웃",
    batter_runner_before_first: "타자주자 1루 전 아웃",
    strikeout: "삼진",
    fly_catch: "뜬공 포구",
    appeal_force: "포스 어필",
    appeal_time: "타임 어필",
    interference: "방해",
    abandonment: "주루 포기",
  }[kind];
}

function kindLabel(kind: ReplayFrame["kind"]): string {
  return {
    half_inning_start: "이닝 시작",
    batter_start: "타석 시작",
    pitch: "투구",
    plate_result: "타석 결과",
    runner_advance: "주자 이동",
    substitution: "선수 교체",
    review: "비디오 판독",
    administrative: "중계 안내",
    unresolved: "미해석 원문",
  }[kind];
}

function kindMark(kind: ReplayFrame["kind"]): string {
  return {
    half_inning_start: "IN",
    batter_start: "PA",
    pitch: "P",
    plate_result: "R",
    runner_advance: "RUN",
    substitution: "SUB",
    review: "REV",
    administrative: "ADM",
    unresolved: "?",
  }[kind];
}

function gameStatusLabel(status: ReplayManifest["status"]): string {
  return {
    scheduled: "예정",
    in_progress: "진행 중",
    final: "종료",
    suspended: "중단",
    cancelled: "취소",
  }[status];
}

function formatGameDate(value: string): string {
  const [year, month, day] = value.split("-");
  return year === undefined || month === undefined || day === undefined
    ? value
    : `${year}.${month}.${day}`;
}

function formatObservedAt(value: string | null): string {
  if (value === null) return "관측 시각 없음";
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? value
    : new Intl.DateTimeFormat("ko-KR", { dateStyle: "short", timeStyle: "medium" }).format(date);
}

function formatMetricValue(value: string | number | boolean | null): string {
  if (value === null) return "null";
  if (typeof value === "boolean") return value ? "true" : "false";
  return String(value);
}

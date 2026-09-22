import { lazy, Suspense } from "react";
import { Route, Routes } from "react-router-dom";

import { AppShell } from "./components/app-shell";
const AnalysisModelsPage = lazy(() =>
  import("./pages/analysis-models-page").then((m) => ({ default: m.AnalysisModelsPage })),
);
const ParkEnvironmentPage = lazy(() =>
  import("./pages/park-environment-page").then((m) => ({ default: m.ParkEnvironmentPage })),
);
const PitchSequencesPage = lazy(() =>
  import("./pages/pitch-sequences-page").then((m) => ({ default: m.PitchSequencesPage })),
);
const BaserunningPage = lazy(() =>
  import("./pages/baserunning-page").then((m) => ({ default: m.BaserunningPage })),
);
const PitcherWorkloadPage = lazy(() =>
  import("./pages/pitcher-workload-page").then((m) => ({ default: m.PitcherWorkloadPage })),
);
const MatchupPage = lazy(() =>
  import("./pages/matchup-page").then((m) => ({ default: m.MatchupPage })),
);
const PitcherChangesPage = lazy(() =>
  import("./pages/pitcher-changes-page").then((m) => ({ default: m.PitcherChangesPage })),
);
const PitchOutcomesPage = lazy(() =>
  import("./pages/pitch-outcomes-page").then((m) => ({ default: m.PitchOutcomesPage })),
);
const PlayerStatisticsPage = lazy(() =>
  import("./pages/player-statistics-page").then((module) => ({
    default: module.PlayerStatisticsPage,
  })),
);

const DashboardPage = lazy(() =>
  import("./pages/dashboard-page").then((module) => ({ default: module.DashboardPage })),
);
const CollectPage = lazy(() =>
  import("./pages/collect-page").then((module) => ({ default: module.CollectPage })),
);
const CorrectPage = lazy(() =>
  import("./pages/correct-page").then((module) => ({ default: module.CorrectPage })),
);
const RecordCorrectionsPage = lazy(() =>
  import("./pages/record-corrections-page").then((module) => ({
    default: module.RecordCorrectionsPage,
  })),
);
const DatabasePage = lazy(() =>
  import("./pages/database-page").then((module) => ({ default: module.DatabasePage })),
);
const ReplayPage = lazy(() =>
  import("./pages/replay-page").then((module) => ({ default: module.ReplayPage })),
);
const SettingsPage = lazy(() =>
  import("./pages/settings-page").then((module) => ({ default: module.SettingsPage })),
);
const PitchAnalysisPage = lazy(() =>
  import("./pages/pitch-analysis-page").then((module) => ({ default: module.PitchAnalysisPage })),
);
const BatterDisciplinePage = lazy(() =>
  import("./pages/batter-discipline-page").then((module) => ({
    default: module.BatterDisciplinePage,
  })),
);
const AnalysisCoveragePage = lazy(() =>
  import("./pages/analysis-coverage-page").then((module) => ({
    default: module.AnalysisCoveragePage,
  })),
);

export function App(): React.JSX.Element {
  return (
    <AppShell>
      <Suspense fallback={<div className="panel loading-panel">화면을 불러오는 중입니다.</div>}>
        <Routes>
          <Route path="/" element={<DashboardPage />} />
          <Route path="/collect" element={<CollectPage />} />
          <Route path="/correct" element={<CorrectPage />} />
          <Route path="/record-corrections" element={<RecordCorrectionsPage />} />
          <Route path="/database" element={<DatabasePage />} />
          <Route path="/replay" element={<ReplayPage />} />
          <Route path="/analysis/pitch-shape" element={<PitchAnalysisPage />} />
          <Route path="/analysis/batter-discipline" element={<BatterDisciplinePage />} />
          <Route path="/analysis/coverage" element={<AnalysisCoveragePage />} />
          <Route path="/analysis/models" element={<AnalysisModelsPage />} />
          <Route path="/analysis/park-environment" element={<ParkEnvironmentPage />} />
          <Route path="/analysis/pitcher-changes" element={<PitcherChangesPage />} />
          <Route path="/analysis/pitch-sequences" element={<PitchSequencesPage />} />
          <Route path="/analysis/baserunning" element={<BaserunningPage />} />
          <Route path="/analysis/pitcher-workload" element={<PitcherWorkloadPage />} />
          <Route path="/analysis/matchups" element={<MatchupPage />} />
          <Route path="/analysis/pitch-location" element={<PitchOutcomesPage role="pitcher" />} />
          <Route path="/analysis/batter-profile" element={<PitchOutcomesPage role="batter" />} />
          <Route path="/analysis/statistics" element={<PlayerStatisticsPage />} />
          <Route path="/settings" element={<SettingsPage />} />
        </Routes>
      </Suspense>
    </AppShell>
  );
}

import { lazy, Suspense } from "react";
import { Route, Routes } from "react-router-dom";

import { AppShell } from "./components/app-shell";

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
          <Route path="/settings" element={<SettingsPage />} />
        </Routes>
      </Suspense>
    </AppShell>
  );
}

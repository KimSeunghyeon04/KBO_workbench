import { Link, useLocation } from "react-router-dom";

export function NotFoundPage() {
  const { pathname } = useLocation();
  const analysis = pathname.startsWith("/analysis/");
  return (
    <div className="page-stack narrow-page">
      <header className="page-header">
        <div>
          <h1>페이지를 찾을 수 없습니다</h1>
          <p>주소가 올바른지 확인하거나 아래 화면에서 작업을 이어가세요.</p>
        </div>
      </header>
      <section className="panel" aria-label="다른 화면으로 이동">
        <p>
          <Link className="primary-button" to={analysis ? "/analysis/players" : "/"}>
            {analysis ? "선수 분석으로 이동" : "데이터 관리 홈으로 이동"}
          </Link>
        </p>
        <Link className="text-link" to={analysis ? "/" : "/analysis/players"}>
          {analysis ? "데이터 관리 홈으로 이동" : "선수 분석으로 이동"}
        </Link>
      </section>
    </div>
  );
}

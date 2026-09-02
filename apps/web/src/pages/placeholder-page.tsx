interface PlaceholderPageProps {
  readonly description: string;
  readonly title: string;
}

export function PlaceholderPage({ title, description }: PlaceholderPageProps): React.JSX.Element {
  return (
    <div className="page-stack narrow-page">
      <header className="page-header">
        <div>
          <h1>{title}</h1>
          <p>{description}</p>
        </div>
      </header>
      <section className="panel placeholder-panel">
        <span className="item-state">준비 중</span>
        <h2>아직 구현되지 않았습니다</h2>
        <p>다음 구현 단계에서 추가합니다.</p>
      </section>
    </div>
  );
}

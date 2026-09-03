import * as React from "react";

export function OperationConsole({
  detail,
  master,
  onBack,
  selected,
}: {
  readonly detail: React.ReactNode;
  readonly master: React.ReactNode;
  readonly onBack: () => void;
  readonly selected: boolean;
}): React.JSX.Element {
  return (
    <div className={selected ? "operation-console has-selection" : "operation-console"}>
      <section className="panel operation-console-master">{master}</section>
      <section className="panel operation-console-detail">
        <button type="button" className="operation-mobile-back" onClick={onBack}>
          ← 목록으로
        </button>
        {detail}
      </section>
    </div>
  );
}

export function OperationEmptyDetail({
  description,
  title,
}: {
  readonly description: string;
  readonly title: string;
}): React.JSX.Element {
  return (
    <div className="operation-empty-detail">
      <span aria-hidden="true">◇</span>
      <strong>{title}</strong>
      <p>{description}</p>
    </div>
  );
}

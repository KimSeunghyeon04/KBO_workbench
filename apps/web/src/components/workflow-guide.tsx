import { useId } from "react";
import "../styles/workflow-guide.css";

export function WorkflowGuide({
  title,
  description,
  steps,
}: {
  readonly title: string;
  readonly description: string;
  readonly steps: readonly { readonly title: string; readonly description: string }[];
}) {
  const headingId = useId();
  return (
    <section className="workflow-guide" aria-labelledby={headingId}>
      <h2 id={headingId}>{title}</h2>
      <p>{description}</p>
      <ol>
        {steps.map((step) => (
          <li key={step.title}>
            <strong>{step.title}</strong>
            <span>{step.description}</span>
          </li>
        ))}
      </ol>
    </section>
  );
}

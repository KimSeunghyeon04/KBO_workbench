import type { EventFieldProps } from "./event-field-context";
import { BatterStartFields, PitchFields, PlateResultFields } from "./event-fields-batting";
import { AdministrativeFields, ReviewFields, UnresolvedFields } from "./event-fields-notice";
import { RunnerFields } from "./event-fields-runner";
import { SubstitutionFields } from "./event-fields-substitution";
export function EventFields(props: EventFieldProps): React.JSX.Element {
  switch (props.form.kind) {
    case "half_inning_start":
      return <p className="muted-text">상태 필드가 없는 원천 경계 행입니다.</p>;
    case "batter_start":
      return <BatterStartFields {...props} />;
    case "pitch":
      return <PitchFields {...props} />;
    case "plate_result":
      return <PlateResultFields {...props} />;
    case "runner_advance":
      return <RunnerFields {...props} />;
    case "substitution":
      return <SubstitutionFields {...props} />;
    case "review":
      return <ReviewFields {...props} />;
    case "administrative":
      return <AdministrativeFields {...props} />;
    case "unresolved":
      return <UnresolvedFields {...props} />;
  }
}

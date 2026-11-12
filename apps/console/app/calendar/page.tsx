import { FlowShell } from "../ui/flow";
import { Calendar } from "../ui/calendar";

export const metadata = {
  title: "Your week — PayFlow",
  description:
    "PayFlow's own calendar. Anything it books for you lands here with the provider's own reference on it, and it never reads your private calendar.",
};

export default function Page() {
  return (
    <FlowShell active="/calendar/">
      <Calendar />
    </FlowShell>
  );
}

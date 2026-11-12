import { FlowShell } from "../ui/flow";
import { Demo } from "../ui/demo";

export const metadata = {
  title: "Try PayFlow — a two-minute walk through one founder's six weeks",
  description:
    "A guided, simulated journey: the plan, the options, the decision that stops at you, a refusal and an unconfirmed outcome. No account, no code, no key.",
};

export default function Page() {
  return (
    <FlowShell active="/try/">
      <Demo />
    </FlowShell>
  );
}

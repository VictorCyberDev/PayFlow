import { FlowShell } from "../ui/flow";
import { Talent } from "../ui/talent";

export const metadata = {
  title: "Talent — PayFlow",
  description:
    "Find real people who have said they are open to work. PayFlow checks that they said it, shows their actual portfolio, and contacts nobody.",
};

export default function Page() {
  return (
    <FlowShell active="/explore/">
      <Talent />
    </FlowShell>
  );
}

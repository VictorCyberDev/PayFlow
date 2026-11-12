import { FlowShell } from "../ui/flow";
import { Flights } from "../ui/flights";

export const metadata = {
  title: "Flights — PayFlow",
  description:
    "Search real fares, compare airlines and total price, and make a sandbox booking with a real reference. PayFlow re-reads the fare before it books and stops if it changed.",
};

export default function Page() {
  return (
    <FlowShell active="/explore/">
      <Flights />
    </FlowShell>
  );
}

import { Suspense } from "react";
import { FlowShell } from "../ui/flow";
import { Partner } from "../ui/partner";

export const metadata = {
  title: "Your partner — PayFlow",
  description:
    "Tell PayFlow what you need done. It writes the plan, estimates the cost and brings you the decisions that are yours.",
};

export default function Page() {
  return (
    <FlowShell active="/partner/">
      <Suspense
        fallback={
          <div className="wrap band">
            <p className="lede">Loading your partner…</p>
          </div>
        }
      >
        <Partner />
      </Suspense>
    </FlowShell>
  );
}

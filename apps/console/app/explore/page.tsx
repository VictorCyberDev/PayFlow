import { Suspense } from "react";
import { FlowShell } from "../ui/flow";
import { Explore } from "../ui/explore";

export const metadata = {
  title: "Explore — PayFlow",
  description:
    "Search real products and compare sellers. PayFlow shows what each seller listed, what the price excludes, and orders nothing without you.",
};

export default function Page() {
  return (
    <FlowShell active="/explore/">
      <Suspense
        fallback={
          <div className="wrap band">
            <p className="lede">Loading…</p>
          </div>
        }
      >
        <Explore />
      </Suspense>
    </FlowShell>
  );
}

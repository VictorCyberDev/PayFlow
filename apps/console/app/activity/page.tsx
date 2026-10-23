import type { Metadata } from "next";
import { Suspense } from "react";
import ActivityView from "../views/activity";
export const metadata: Metadata = { title: "Activity · PayFlow" };
export default function Page() {
  return (
    <Suspense>
      <ActivityView />
    </Suspense>
  );
}

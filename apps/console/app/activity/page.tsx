import type { Metadata } from "next";
import { Suspense } from "react";
import ActivityView from "../views/activity";
import { BRAND } from "../../lib/brand";
export const metadata: Metadata = { title: `Activity · ${BRAND.name}` };
export default function Page() {
  return (
    <Suspense>
      <ActivityView />
    </Suspense>
  );
}

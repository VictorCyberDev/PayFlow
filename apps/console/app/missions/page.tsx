import type { Metadata } from "next";
import { Suspense } from "react";
import MissionsView from "../views/missions";
import { BRAND } from "../../lib/brand";
export const metadata: Metadata = { title: `Missions · ${BRAND.name}` };
export default function Page() {
  return (
    <Suspense>
      <MissionsView />
    </Suspense>
  );
}

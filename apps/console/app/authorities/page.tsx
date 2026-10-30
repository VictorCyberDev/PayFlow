import type { Metadata } from "next";
import { Suspense } from "react";
import AuthoritiesView from "../views/authorities";
import { BRAND } from "../../lib/brand";
export const metadata: Metadata = { title: `Authorities · ${BRAND.name}` };
export default function Page() {
  return (
    <Suspense>
      <AuthoritiesView />
    </Suspense>
  );
}

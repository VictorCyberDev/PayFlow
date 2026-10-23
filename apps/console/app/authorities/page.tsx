import type { Metadata } from "next";
import { Suspense } from "react";
import AuthoritiesView from "../views/authorities";
export const metadata: Metadata = { title: "Authorities · PayFlow" };
export default function Page() {
  return (
    <Suspense>
      <AuthoritiesView />
    </Suspense>
  );
}

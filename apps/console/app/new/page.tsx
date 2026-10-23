import type { Metadata } from "next";
import NewAuthorityView from "../views/new";
export const metadata: Metadata = { title: "New Authority · PayFlow" };
export default function Page() {
  return <NewAuthorityView />;
}

import type { Metadata } from "next";
import NewAuthorityView from "../views/new";
import { BRAND } from "../../lib/brand";
export const metadata: Metadata = { title: `New Authority · ${BRAND.name}` };
export default function Page() {
  return <NewAuthorityView />;
}

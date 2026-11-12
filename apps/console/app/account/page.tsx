import { FlowShell } from "../ui/flow";
import { Account } from "../ui/account";

export const metadata = {
  title: "Your workspace — PayFlow",
  description:
    "Make a PayFlow workspace with a name, an email and a password. No access code, no API key, nothing to configure.",
};

export default function Page() {
  return (
    <FlowShell active="/account/">
      <Account />
    </FlowShell>
  );
}

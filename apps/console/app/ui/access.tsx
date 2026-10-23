"use client";
import { useId, useState } from "react";
import { useConsole } from "./provider";

/** Demo access only. It never describes or creates Authority. */
export function AccessGate({
  lead,
  onOpened,
}: {
  lead: string;
  onOpened?: () => void;
}) {
  const { login } = useConsole();
  const id = useId();
  const [failed, setFailed] = useState(false);
  const [busy, setBusy] = useState(false);
  return (
    <section className="access" aria-labelledby={id + "-t"}>
      <h2 id={id + "-t"} className="h3">
        Demo access
      </h2>
      <p>{lead}</p>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          const form = event.currentTarget;
          const code = String(new FormData(form).get("bootstrapCode") ?? "");
          form.reset();
          setBusy(true);
          setFailed(false);
          void login(code).then((ok) => {
            setBusy(false);
            setFailed(!ok);
            if (ok) onOpened?.();
          });
        }}
      >
        <label htmlFor={id + "-c"}>Access code</label>
        <div className="access__row">
          <input
            id={id + "-c"}
            name="bootstrapCode"
            type="password"
            autoComplete="off"
            required
            maxLength={256}
            aria-describedby={failed ? id + "-e" : undefined}
          />
          <button type="submit" className="btn" disabled={busy}>
            Open demo
          </button>
        </div>
        <p id={id + "-e"} role="status" className="field-note">
          {failed ? "That code didn't work. Check it and try again." : ""}
        </p>
      </form>
    </section>
  );
}

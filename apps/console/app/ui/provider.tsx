"use client";
import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import {
  createActivationController,
  type ActivationState,
} from "../../lib/activation-client.mjs";
import {
  createManagementController,
  type ManagementState,
} from "../../lib/management-client.mjs";

type Activation = ReturnType<typeof createActivationController>;
type Management = ReturnType<typeof createManagementController>;

export type Session = "checking" | "signed-out" | "signed-in";
type Ctx = {
  session: Session;
  management: ManagementState;
  activation: ActivationState;
  now: Date;
  login: (code: string) => Promise<boolean>;
  logout: () => Promise<void>;
  prepare: (source: string) => Promise<void>;
  confirm: () => Promise<void>;
  invalidateFlow: () => void;
  resetFlow: () => void;
  requestRevoke: (id: string) => void;
  cancelRevoke: () => void;
  revoke: () => Promise<void>;
  retry: () => void;
};
const Console = createContext<Ctx | null>(null);
/** Exposed for component tests and the visual QA gallery, which supply fixture state. */
export const ConsoleContext = Console;
export type ConsoleValue = Ctx;
export function useConsole(): Ctx {
  const c = useContext(Console);
  if (!c) throw new Error("ConsoleProvider missing");
  return c;
}

const initialManagement: ManagementState = {
  status: "SIGNED_OUT",
  authorities: [],
  activity: [],
  error: null,
  selected: null,
};
const initialActivation: ActivationState = {
  status: "SIGNED_OUT",
  pending: null,
  authority: null,
};

/**
 * One owner of the two accepted M5 controllers so every destination reads the same server-backed
 * projections. Browser state is never financial truth: every value shown comes from a fresh,
 * validated server read, and the system (not the customer) keeps it fresh.
 */
export function ConsoleProvider({ children }: { children: ReactNode }) {
  const [management, setManagement] = useState(initialManagement);
  const [activation, setActivation] = useState(initialActivation);
  const [checked, setChecked] = useState(false);
  const [now, setNow] = useState(() => new Date());
  const m = useRef<Management | null>(null);
  const a = useRef<Activation | null>(null);

  useEffect(() => {
    const mc = createManagementController(setManagement);
    const ac = createActivationController(setActivation, undefined, () => {
      void mc.refresh();
    });
    m.current = mc;
    a.current = ac;
    void ac.restore(null).then(() => {
      setChecked(true);
      void mc.refresh();
    });
    let ticks = 0;
    const timer = setInterval(() => {
      mc.expire();
      ac.expire();
      ticks++;
      if (ticks % 15 === 0 && ac.getState().status !== "SIGNED_OUT")
        void mc.refresh();
      if (ticks % 30 === 0) setNow(new Date());
    }, 1000);
    const onFocus = () => {
      setNow(new Date());
      if (ac.getState().status !== "SIGNED_OUT") void mc.refresh();
    };
    window.addEventListener("focus", onFocus);
    return () => {
      clearInterval(timer);
      window.removeEventListener("focus", onFocus);
      mc.dispose();
      ac.dispose();
    };
  }, []);

  // Stable action identities: effects in views depend on them and must not re-run per state change.
  const actions = useMemo(
    () => ({
      login: async (code: string) => {
        await a.current?.login(code);
        const ok = a.current?.getState().status !== "SIGNED_OUT";
        if (ok) await m.current?.refresh();
        return ok;
      },
      logout: async () => {
        await a.current?.logout();
        await m.current?.refresh();
      },
      prepare: async (source: string) =>
        void (await a.current?.prepare(source)),
      confirm: async () => void (await a.current?.confirm()),
      invalidateFlow: () => a.current?.invalidate(),
      resetFlow: () => {
        const s = a.current?.getState().status;
        if (s && s !== "SIGNED_OUT" && s !== "IDLE")
          void a.current?.restore(null);
      },
      requestRevoke: (id: string) => m.current?.requestRevoke(id),
      cancelRevoke: () => m.current?.cancelRevoke(),
      revoke: async () => void (await m.current?.revoke()),
      retry: () => void m.current?.refresh(),
    }),
    [],
  );
  const value = useMemo<Ctx>(
    () => ({
      session: !checked
        ? "checking"
        : activation.status === "SIGNED_OUT"
          ? "signed-out"
          : "signed-in",
      management,
      activation,
      now,
      ...actions,
    }),
    [checked, management, activation, now, actions],
  );
  return <Console.Provider value={value}>{children}</Console.Provider>;
}

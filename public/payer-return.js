(() => {
  "use strict";
  const root = document.querySelector("main");
  const token = root?.dataset.token;
  if (
    root?.dataset.state !== "CHECKING_PAYMENT_STATUS" ||
    !token ||
    !/^[A-Z0-9]{17}$/.test(token)
  )
    return;
  const title = document.getElementById("title");
  const message = document.getElementById("message");
  const reference = document.getElementById("reference");
  const deadline = Date.now() + 25000;
  let stopped = false;
  let next;
  let active;
  const finish = () => {
    stopped = true;
    clearTimeout(next);
    clearTimeout(limit);
    active?.abort();
  };
  const limit = setTimeout(() => {
    finish();
    title.textContent = "Still checking payment status";
    message.textContent =
      "We are still verifying the final payment state. You can safely refresh this page. Please do not pay again.";
  }, 25000);
  async function check() {
    if (stopped || Date.now() >= deadline) return;
    active = new AbortController();
    try {
      const response = await fetch(
        "/paypal/status?token=" + encodeURIComponent(token),
        {
          cache: "no-store",
          credentials: "same-origin",
          signal: active.signal,
        },
      );
      const view = await response.json();
      if (stopped || Date.now() >= deadline) return;
      if (
        ["PAYMENT_COMPLETE", "PAYMENT_FAILED", "PAYMENT_CANCELLED"].includes(
          view.state,
        ) &&
        typeof view.title === "string" &&
        typeof view.message === "string"
      ) {
        // An error/unknown state is unavailable, never a guessed success.
        if (!response.ok && view.state === "PAYMENT_COMPLETE") return;
        finish();
        root.dataset.state = view.state;
        title.textContent = view.title;
        message.textContent = view.message;
        reference.textContent =
          typeof view.reference === "string"
            ? "Reference: " + view.reference
            : "";
        return;
      }
    } catch {
      // Temporary network loss is not evidence of failed payment.
    }
    if (!stopped) next = setTimeout(check, 2000);
  }
  window.addEventListener("pagehide", finish, { once: true });
  void check();
})();

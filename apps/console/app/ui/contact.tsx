"use client";
import { useState } from "react";
export function ContactForm() {
  const [kind, setKind] = useState("Developer support");
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [message, setMessage] = useState("");
  return (
    <form
      className="contact-form"
      onSubmit={(event) => {
        event.preventDefault();
        window.location.href = `mailto:victornnajiofor1@gmail.com?subject=${encodeURIComponent(`PayFlow / ${kind}`)}&body=${encodeURIComponent(`Name: ${name}\nReply to: ${email}\n\n${message}`)}`;
      }}
    >
      <label>
        Inquiry type
        <select value={kind} onChange={(e) => setKind(e.target.value)}>
          {[
            "Developer support",
            "Design partner",
            "Enterprise",
            "Security",
          ].map((x) => (
            <option key={x}>{x}</option>
          ))}
        </select>
      </label>
      <label>
        Name
        <input
          required
          value={name}
          onChange={(e) => setName(e.target.value)}
          autoComplete="name"
          maxLength={120}
        />
      </label>
      <label>
        Email
        <input
          required
          type="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          autoComplete="email"
          maxLength={254}
        />
      </label>
      <label>
        What are you evaluating?
        <textarea
          required
          value={message}
          onChange={(e) => setMessage(e.target.value)}
          maxLength={3000}
        />
      </label>
      <p className="note" id="contact-notice">
        Opens an email draft. Nothing is sent until you choose Send. Do not
        include secrets or financial information.
      </p>
      <button
        className="company-button"
        type="submit"
        aria-describedby="contact-notice"
      >
        Prepare inquiry ↗
      </button>
    </form>
  );
}

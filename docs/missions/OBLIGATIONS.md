# Obligations (M44)

Dates the mission must not forget.

- **Derived** from the quote's terms, once per order and kind, and only from facts a person has verified:
  - `DELIVERY_DEADLINE` = order created + `deliveryDays`.
  - `RETURN_WINDOW` = **verified** delivery date + `returnWindowDays`.
  - `WARRANTY_END` = **verified** delivery date + `warrantyMonths` (calendar months; 31 Jan + 1 month is the last day of February).
    An agent's claim of delivery starts nothing. Deriving again changes nothing.
- **Reminders.** A person, or an agent that can READ the mission, may add a `CUSTOM`, `RENEWAL` or `PAYMENT_DUE` reminder with a date
  and optional amount. These are notes; they move no money.
- **Urgency is computed when asked**, never stored: `OVERDUE` (due before today), `DUE_SOON` (within 7 days, including today),
  `UPCOMING`, or `DONE`/`WAIVED`.
- **Only a person closes one**, as `DONE` or `WAIVED`, once. A closed obligation cannot change (the database refuses it) and none is
  ever deleted.

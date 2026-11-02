# Pricing and metering architecture

Status: metering is internally implementable; willingness-to-pay validation remains **BLOCKED_EXTERNAL** until real market evidence exists.

The product meters governed actions, verification calls, active agents and enterprise controls. Durable usage events carry an organization, environment, quantity, timestamp and idempotency key so billing logic can be replay-safe.

Commercial direction remains:

- Developer: generous sandbox/free use.
- Platform: subscription and/or governed-action usage.
- Enterprise: annual commitment plus organization controls, support and integrations.
- Verification: free or extremely low friction where strategically useful.

The code contains placeholder pricing coefficients only to test arithmetic and invoice aggregation. They are not a published price sheet, revenue forecast or evidence that customers will pay. Percentage-of-payment-volume is not the default economic model.

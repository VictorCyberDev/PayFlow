-- M10: orders for the clearly-labelled SIMULATED sandbox rail. No money, no provider.
-- Kept in the database so an order created by one serverless invocation is visible to the next.
CREATE TABLE simulated_provider_orders (
  order_id text PRIMARY KEY CHECK (order_id ~ '^SIM-[A-F0-9]{24}$'),
  create_request_id text NOT NULL UNIQUE,
  capture_request_id text UNIQUE,
  view jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

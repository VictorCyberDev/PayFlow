import json
import threading
import unittest
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path
import sys

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from payflow.client import ExecuteResult, PayFlowClient, PayFlowError  # noqa: E402


class Handler(BaseHTTPRequestHandler):
    seen = []

    def log_message(self, *args):  # silence test output
        pass

    def _reply(self, status, body):
        raw = json.dumps(body).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(raw)))
        self.end_headers()
        self.wfile.write(raw)

    def do_GET(self):
        Handler.seen.append((self.command, self.path, self.headers.get("Authorization")))
        if self.path == "/v1/authorities/missing":
            return self._reply(404, {"error": {"code": "AUTHORITY_NOT_FOUND"}})
        self._reply(200, {"authority": {"id": "a1", "status": "ACTIVE"}})

    def do_POST(self):
        length = int(self.headers.get("Content-Length", "0"))
        body = json.loads(self.rfile.read(length))
        Handler.seen.append((self.command, self.path, body.get("nonce")))
        if self.path == "/v1/actions/execute":
            kind = body["nonce"].split("-")[0]
            ok = {"requestId": "r1", "proof": {"proposalId": "p1", "href": "/v1/proofs/p1"}}
            if kind == "completed":
                return self._reply(200, {**ok, "decision": "ALLOW", "status": "COMPLETED", "effectCount": 1,
                                         "recoverable": False, "humanSummary": "Paid once", "nextAction": "INSPECT_PROOF"})
            if kind == "denied":
                return self._reply(200, {**ok, "decision": "DENY", "status": "DENIED", "effectCount": 0,
                                         "reason": "AMOUNT_EXCEEDS_AUTHORITY", "recoverable": True,
                                         "humanSummary": "Over limit", "nextAction": "REDUCE_AMOUNT_OR_REQUEST_APPROVAL"})
            if kind == "unresolved":
                return self._reply(200, {**ok, "decision": "ALLOW", "status": "UNRESOLVED", "effectCount": None,
                                         "doNotRetry": True, "humanSummary": "We're confirming whether money moved.",
                                         "nextAction": "DO_NOT_RETRY_WAIT_FOR_RECONCILIATION"})
            if kind == "unauthorized":
                return self._reply(401, {"requestId": "r2", "reason": "ACCESS_INACTIVE", "humanSummary": "No",
                                         "nextAction": "USE_A_VALID_CREDENTIAL"})
            return self._reply(500, {"requestId": "r3", "reason": "INTERNAL_ERROR", "effectCount": None})
        self._reply(200, {"decision": {"decision": "DENY", "reasonCodes": ["REPLAY_DETECTED"]}})


class ClientTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.server = HTTPServer(("127.0.0.1", 0), Handler)
        cls.thread = threading.Thread(target=cls.server.serve_forever, daemon=True)
        cls.thread.start()
        cls.client = PayFlowClient(f"http://127.0.0.1:{cls.server.server_port}", "agent-token")

    @classmethod
    def tearDownClass(cls):
        cls.server.shutdown()

    def test_reads_authority_with_bearer_token_and_encodes_the_id(self):
        result = self.client.read_authority("a/1")
        self.assertEqual(result["authority"]["status"], "ACTIVE")
        self.assertEqual(Handler.seen[-1], ("GET", "/v1/authorities/a%2F1", "Bearer agent-token"))

    def test_posts_the_exact_action_and_surfaces_the_decision(self):
        result = self.client.request_authorized_action({"nonce": "n" * 16})
        self.assertEqual(result["decision"]["reasonCodes"], ["REPLAY_DETECTED"])

    def test_http_errors_raise_a_typed_error_with_the_body(self):
        with self.assertRaises(PayFlowError) as caught:
            self.client.read_authority("missing")
        self.assertEqual(caught.exception.status, 404)
        self.assertEqual(caught.exception.body["error"]["code"], "AUTHORITY_NOT_FOUND")

    def test_client_never_holds_payment_credentials(self):
        # Only the PayFlow bearer token and URL are state; the rest are method namespaces.
        self.assertEqual(sorted(vars(self.client)), ["access_token", "actions", "base_url", "proofs"])
        self.assertFalse([k for k in vars(self.client) if "paypal" in k.lower() or "provider" in k.lower()])

    def _execute(self, kind, client=None):
        return (client or self.client).actions.execute(
            authority="a1", agent="ag1", item="Quiet keyboard", amount=8400,
            currency="USD", merchant="m1", nonce=f"{kind}-0123456789abcdef",
        )

    def test_execute_completed_is_exactly_one_effect(self):
        r = self._execute("completed")
        self.assertIsInstance(r, ExecuteResult)
        self.assertEqual((r.status, r.effect_count, r.proof["proposalId"]), ("COMPLETED", 1, "p1"))

    def test_execute_denied_is_structured_and_zero_effect(self):
        r = self._execute("denied")
        self.assertEqual((r.status, r.effect_count, r.recoverable, r.reason), ("DENIED", 0, True, "AMOUNT_EXCEEDS_AUTHORITY"))

    def test_execute_unresolved_never_claims_zero(self):
        r = self._execute("unresolved")
        self.assertEqual(r.status, "UNRESOLVED")
        self.assertIsNone(r.effect_count)
        self.assertTrue(r.do_not_retry)
        self.assertFalse(r.money_moved_known)

    def test_execute_auth_failure_is_rejected_not_raised(self):
        r = self._execute("unauthorized")
        self.assertEqual((r.status, r.effect_count, r.http_status), ("REJECTED", 0, 401))

    def test_execute_server_error_is_indeterminate_not_zero(self):
        r = self._execute("boom")
        self.assertEqual(r.status, "INDETERMINATE")
        self.assertIsNone(r.effect_count)
        self.assertTrue(r.do_not_retry)

    def test_execute_transport_failure_is_indeterminate_not_zero(self):
        r = self._execute("completed", PayFlowClient("http://127.0.0.1:1", "t"))
        self.assertEqual((r.status, r.reason), ("INDETERMINATE", "TRANSPORT_FAILURE"))
        self.assertIsNone(r.effect_count)

    def test_execute_generates_a_nonce_when_omitted(self):
        self.client.actions.execute(authority="a", agent="b", item="x", amount=1, currency="USD", merchant="m")
        self.assertTrue(Handler.seen[-1][2].startswith("nonce_"))


if __name__ == "__main__":
    unittest.main()

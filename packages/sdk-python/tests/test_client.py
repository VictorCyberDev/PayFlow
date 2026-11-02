import json
import threading
import unittest
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path
import sys

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from payflow.client import PayFlowClient, PayFlowError  # noqa: E402


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
        self.assertEqual(sorted(vars(self.client)), ["access_token", "base_url"])


if __name__ == "__main__":
    unittest.main()

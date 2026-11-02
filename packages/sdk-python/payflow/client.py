import json
from urllib.error import HTTPError
from urllib.parse import quote
from urllib.request import Request, urlopen


class PayFlowError(RuntimeError):
    def __init__(self, status: int, body: object):
        super().__init__(f"PayFlow API request failed with {status}")
        self.status = status
        self.body = body


class PayFlowClient:
    """Small dependency-free preview client. Never stores payment credentials."""

    def __init__(self, base_url: str, access_token: str):
        self.base_url = base_url.rstrip("/")
        self.access_token = access_token

    def read_authority(self, authority_id: str) -> object:
        return self._json("GET", f"/v1/authorities/{quote(authority_id, safe='')}")

    def request_authorized_action(self, action: dict) -> object:
        return self._json("POST", "/v1/actions", action)

    def _json(self, method: str, path: str, body: object | None = None) -> object:
        payload = None if body is None else json.dumps(body).encode("utf-8")
        request = Request(
            f"{self.base_url}{path}",
            method=method,
            data=payload,
            headers={
                "Authorization": f"Bearer {self.access_token}",
                "Content-Type": "application/json",
            },
        )
        try:
            with urlopen(request, timeout=15) as response:
                return json.loads(response.read().decode("utf-8"))
        except HTTPError as exc:
            raw = exc.read().decode("utf-8")
            try:
                parsed = json.loads(raw)
            except json.JSONDecodeError:
                parsed = {"message": raw}
            raise PayFlowError(exc.code, parsed) from exc

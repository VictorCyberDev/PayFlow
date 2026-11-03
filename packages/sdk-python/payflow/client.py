import json
import uuid
from dataclasses import dataclass, field
from typing import Optional
from urllib.error import HTTPError
from urllib.parse import quote
from urllib.request import Request, urlopen


class PayFlowError(RuntimeError):
    def __init__(self, status: int, body: object):
        super().__init__(f"PayFlow API request failed with {status}")
        self.status = status
        self.body = body


@dataclass(frozen=True)
class ExecuteResult:
    """Outcome of ``actions.execute``. Switch on ``status``.

    COMPLETED     paid exactly once (effect_count == 1)
    DENIED        refused before money moved (effect_count == 0); see reason/next_action
    NEEDS_APPROVAL a human must decide; nothing moved
    UNRESOLVED    PayFlow is confirming whether money moved (effect_count is None, never 0)
    REJECTED      refused at the door: bad credential, scope or shape (effect_count == 0)
    INDETERMINATE transport/server failure after sending; effect unknown (effect_count is None)

    ``do_not_retry`` is True whenever the effect is unknown.
    """

    status: str
    decision: str
    effect_count: Optional[int]
    request_id: str = "unknown"
    reason: Optional[str] = None
    recoverable: bool = False
    do_not_retry: bool = False
    human_summary: str = ""
    next_action: str = ""
    proof: dict = field(default_factory=dict)
    http_status: int = 200

    @property
    def money_moved_known(self) -> bool:
        return self.effect_count is not None


def _result(body: dict, http_status: int) -> ExecuteResult:
    return ExecuteResult(
        status=body.get("status", "REJECTED"),
        decision=body.get("decision", "DENY"),
        effect_count=body.get("effectCount"),
        request_id=body.get("requestId", "unknown"),
        reason=body.get("reason"),
        recoverable=bool(body.get("recoverable", False)),
        do_not_retry=bool(body.get("doNotRetry", False)),
        human_summary=body.get("humanSummary", ""),
        next_action=body.get("nextAction", ""),
        proof=body.get("proof") or {},
        http_status=http_status,
    )


def _indeterminate(reason: str, summary: str) -> ExecuteResult:
    return ExecuteResult(
        status="INDETERMINATE",
        decision="UNKNOWN",
        effect_count=None,
        reason=reason,
        do_not_retry=True,
        human_summary=summary,
        next_action="DO_NOT_RETRY_CHECK_PROOF",
    )


class _Actions:
    def __init__(self, client: "PayFlowClient"):
        self._client = client

    def execute(
        self,
        *,
        authority: str,
        agent: str,
        item: str,
        amount: int,
        currency: str,
        merchant: str,
        quantity: int = 1,
        nonce: Optional[str] = None,
        request_id: Optional[str] = None,
    ) -> ExecuteResult:
        """Ask PayFlow for a bounded purchase. Never raises for a PayFlow outcome.

        ``amount`` is in minor units and is only checked against the trusted price.
        Reuse ``nonce`` to retry the SAME logical request: a repeat is denied and never pays twice.
        """
        body = {
            "authority": authority,
            "agentId": agent,
            "action": "purchase",
            "query": {"text": item, "quantity": quantity},
            "amount": {"minor": amount, "currency": currency},
            "merchant": {"id": merchant},
            "nonce": nonce or f"nonce_{uuid.uuid4()}",
        }
        if request_id:
            body["requestId"] = request_id
        try:
            status, parsed = self._client._raw("POST", "/v1/actions/execute", body)
        except OSError:
            # The request may have reached PayFlow. Never claim zero effect.
            return _indeterminate(
                "TRANSPORT_FAILURE",
                "We couldn't confirm the result. Don't retry yet; check the Proof.",
            )
        if status == 200:
            return _result(parsed, status)
        if status in (400, 401, 403, 404):
            return _result({**parsed, "status": "REJECTED", "decision": "DENY", "effectCount": 0}, status)
        return _indeterminate(
            str(parsed.get("reason", "SERVER_ERROR")),
            str(parsed.get("humanSummary", "We're confirming whether money moved. Don't retry yet.")),
        )


class _Proofs:
    def __init__(self, client: "PayFlowClient"):
        self._client = client

    def get(self, proposal_id: str) -> object:
        return self._client._json("GET", f"/v1/proofs/{quote(proposal_id, safe='')}")


class PayFlowClient:
    """Small dependency-free preview client. Never stores payment credentials."""

    def __init__(self, base_url: str, access_token: str):
        self.base_url = base_url.rstrip("/")
        self.access_token = access_token
        self.actions = _Actions(self)
        self.proofs = _Proofs(self)

    def read_authority(self, authority_id: str) -> object:
        return self._json("GET", f"/v1/authorities/{quote(authority_id, safe='')}")

    def request_authorized_action(self, action: dict) -> object:
        return self._json("POST", "/v1/actions", action)

    def _raw(self, method: str, path: str, body: object | None = None):
        """Return (status, parsed_json) for any HTTP status. Network errors raise OSError."""
        try:
            return 200, self._json(method, path, body)
        except PayFlowError as exc:
            return exc.status, exc.body if isinstance(exc.body, dict) else {"message": str(exc.body)}

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

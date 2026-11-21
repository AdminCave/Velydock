"""API errors with stable machine-readable codes (the frontend maps codes to translated text)."""

from __future__ import annotations

import logging
from typing import Any

from fastapi import FastAPI, Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse
from sqlalchemy.exc import DBAPIError, InterfaceError, OperationalError
from sqlalchemy.exc import TimeoutError as SATimeoutError
from starlette.exceptions import HTTPException as StarletteHTTPException

log = logging.getLogger(__name__)


class ApiError(Exception):
    def __init__(self, status: int, code: str, message: str, details: dict[str, Any] | None = None) -> None:
        super().__init__(message)
        self.status = status
        self.code = code
        self.message = message
        self.details = details or {}


def not_authenticated() -> ApiError:
    return ApiError(401, "not_authenticated", "Sign-in required.")


def forbidden(message: str = "You are not allowed to do this.") -> ApiError:
    return ApiError(403, "forbidden", message)


def not_found(what: str = "Resource") -> ApiError:
    # Also used when a resource exists in another tenant: its existence must not leak.
    return ApiError(404, "not_found", f"{what} not found.")


def conflict(code: str, message: str) -> ApiError:
    return ApiError(409, code, message)


def invalid(message: str, code: str = "validation", details: dict[str, Any] | None = None) -> ApiError:
    return ApiError(422, code, message, details)


def database_unavailable(exc: BaseException) -> ApiError:
    """The database cannot be reached: one line in the log and an answer the client understands.

    Without this every request during an outage would fail with a full traceback in the log -
    a few hundred lines each, burying whatever explains the outage.
    """
    reason = str(exc).strip().splitlines()[0][:200] if str(exc).strip() else type(exc).__name__
    log.error("database unreachable (%s): %s", type(exc).__name__, reason)
    return ApiError(503, "unavailable", "The service is temporarily unavailable.")


def is_connection_failure(exc: BaseException) -> bool:
    """Is this the database being away (as opposed to a statement that is wrong)?"""
    if isinstance(exc, (OSError, SATimeoutError, InterfaceError, OperationalError)):
        return True
    return isinstance(exc, DBAPIError) and bool(exc.connection_invalidated)


def idp_unavailable() -> ApiError:
    return ApiError(503, "idp_unavailable", "The identity provider is currently not reachable.")


def _body(code: str, message: str, details: dict[str, Any] | None = None) -> dict[str, Any]:
    return {"error": {"code": code, "message": message, "details": details or {}}}


_STATUS_CODES = {
    400: "bad_request",
    401: "not_authenticated",
    403: "forbidden",
    404: "not_found",
    405: "method_not_allowed",
    413: "too_large",
    429: "rate_limited",
}


def install_error_handlers(app: FastAPI) -> None:
    @app.exception_handler(ApiError)
    async def _api_error(_: Request, exc: ApiError) -> JSONResponse:
        return JSONResponse(_body(exc.code, exc.message, exc.details), status_code=exc.status)

    @app.exception_handler(RequestValidationError)
    async def _validation(_: Request, exc: RequestValidationError) -> JSONResponse:
        fields = [
            {"field": ".".join(str(p) for p in err["loc"] if p != "body"), "message": err["msg"]}
            for err in exc.errors()
        ]
        return JSONResponse(
            _body("validation", "The request is invalid.", {"fields": fields}), status_code=422
        )

    @app.exception_handler(DBAPIError)
    async def _database(_: Request, exc: DBAPIError) -> JSONResponse:
        # Two changes that got in each other's way (PostgreSQL ended one of them to resolve a
        # deadlock, or could not serialize them). The database took nothing of this request;
        # repeating it works, and also completes whatever it had already told the identity
        # provider.
        state = getattr(exc.orig, "sqlstate", None) or getattr(exc.orig, "pgcode", None)
        if state in ("40P01", "40001"):
            return JSONResponse(
                _body("try_again", "Another change happened at the same moment. Please try again."),
                status_code=409,
            )
        if is_connection_failure(exc):
            # The connection broke in the middle of a request.
            unavailable = database_unavailable(exc)
            return JSONResponse(_body(unavailable.code, unavailable.message), status_code=unavailable.status)
        raise exc

    @app.exception_handler(StarletteHTTPException)
    async def _http(_: Request, exc: StarletteHTTPException) -> JSONResponse:
        code = _STATUS_CODES.get(exc.status_code, "error")
        return JSONResponse(_body(code, str(exc.detail)), status_code=exc.status_code, headers=exc.headers)

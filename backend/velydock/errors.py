"""API errors with stable machine-readable codes (the frontend maps codes to translated text)."""

from __future__ import annotations

from typing import Any

from fastapi import FastAPI, Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse
from starlette.exceptions import HTTPException as StarletteHTTPException


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

    @app.exception_handler(StarletteHTTPException)
    async def _http(_: Request, exc: StarletteHTTPException) -> JSONResponse:
        code = _STATUS_CODES.get(exc.status_code, "error")
        return JSONResponse(_body(code, str(exc.detail)), status_code=exc.status_code, headers=exc.headers)

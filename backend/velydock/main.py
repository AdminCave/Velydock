"""ASGI entry point: ``uvicorn velydock.main:app``."""

from velydock.app import create_app

app = create_app()

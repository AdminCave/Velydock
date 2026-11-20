# Velydock – one image for the UI, the API and the Keycloak login theme.
#
#   docker build -t velydock .

# ---- frontend ----------------------------------------------------------------------------------
FROM node:22-alpine AS frontend
WORKDIR /src
COPY frontend/package.json frontend/package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY frontend/ ./
COPY backend/openapi.json /backend/openapi.json
RUN npm run build

# ---- runtime -----------------------------------------------------------------------------------
FROM python:3.13-slim AS runtime
ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1
WORKDIR /app

# Dependencies first (cached layer); every package is pinned and verified by hash.
COPY backend/requirements.txt ./
RUN pip install --require-hashes -r requirements.txt

COPY backend/pyproject.toml backend/README.md ./
COPY backend/velydock ./velydock
RUN pip install --no-deps . && rm -rf build velydock.egg-info

COPY --from=frontend /src/dist /app/static
COPY deploy/keycloak/theme /opt/velydock/keycloak-theme

RUN useradd --system --uid 10001 --user-group --no-create-home --shell /usr/sbin/nologin velydock
USER 10001:10001

EXPOSE 8000
ENTRYPOINT ["velydock"]
CMD ["run"]

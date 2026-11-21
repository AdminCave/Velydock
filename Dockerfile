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

# Security fixes Debian has published since the base image was built.
RUN apt-get update \
    && apt-get upgrade -y --no-install-recommends \
    && rm -rf /var/lib/apt/lists/*

# Dependencies first (cached layer); every package is pinned and verified by hash.
COPY backend/requirements.txt ./
RUN pip install --require-hashes -r requirements.txt

COPY backend/pyproject.toml backend/README.md ./
COPY backend/velydock ./velydock
# The running service installs nothing. Without pip, the libraries pip bundles for its own use
# (and their security advisories) are not part of the image either.
RUN pip install --no-deps . \
    && rm -rf build velydock.egg-info \
    && pip uninstall -y pip \
    && rm -rf /usr/local/lib/python3.13/ensurepip/_bundled

COPY --from=frontend /src/dist /app/static
COPY deploy/keycloak/theme /opt/velydock/keycloak-theme

RUN useradd --system --uid 10001 --user-group --no-create-home --shell /usr/sbin/nologin velydock
USER 10001:10001

EXPOSE 8000
ENTRYPOINT ["velydock"]
CMD ["run"]

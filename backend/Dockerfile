FROM python:3.12-slim-bookworm

COPY --from=ghcr.io/astral-sh/uv:0.13.5 /uv /uvx /bin/

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    UV_PROJECT_ENVIRONMENT=/opt/venv \
    UV_LINK_MODE=copy \
    UV_COMPILE_BYTECODE=1 \
    PATH="/opt/venv/bin:$PATH"

# GeoDjango needs GDAL, GEOS and PROJ shared libraries.
RUN apt-get update \
    && apt-get install -y --no-install-recommends binutils gdal-bin libproj-dev \
    && rm -rf /var/lib/apt/lists/*

RUN useradd --create-home --uid 1000 app \
    && mkdir -p /var/lib/agri/private /opt/venv \
    && chown -R app:app /var/lib/agri /opt/venv

WORKDIR /app
USER app

# Install deps first (cached layer); the source is bind-mounted in dev.
COPY --chown=app:app pyproject.toml uv.lock ./
RUN uv sync --frozen --no-install-project

COPY --chown=app:app . .

EXPOSE 8000
CMD ["python", "manage.py", "runserver", "0.0.0.0:8000"]

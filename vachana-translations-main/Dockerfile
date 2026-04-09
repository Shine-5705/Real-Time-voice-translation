FROM node:22-bookworm-slim AS ui-builder

WORKDIR /app/ui
COPY ui/package*.json ./
RUN npm ci
COPY ui/ ./
RUN npm run build

FROM python:3.13-slim

ENV DEBIAN_FRONTEND=noninteractive \
    PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1

WORKDIR /app

RUN apt-get update && apt-get install -y --no-install-recommends \
    ffmpeg \
    && apt-get clean \
    && rm -rf /var/lib/apt/lists/*

COPY requirements.txt ./
RUN python3.13 -m pip install --no-cache-dir uv && python3.13 -m uv pip install --no-cache-dir -r requirements.txt

COPY backend/ ./backend/
COPY db/ ./db/
COPY main.py ./main.py
COPY config.json ./config.json
COPY --from=ui-builder /app/ui/dist ./ui/dist

EXPOSE 8112

CMD ["python3.13", "-m", "uvicorn", "main:app", "--host", "0.0.0.0", "--port", "8112"]

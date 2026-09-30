FROM python:3.12-slim
RUN apt-get update && apt-get install -y --no-install-recommends libmagic1 && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY requirements.lock ./
RUN pip install --no-cache-dir -r requirements.lock
COPY pyproject.toml ./
COPY factos ./factos
RUN pip install --no-deps --no-cache-dir .
RUN useradd --create-home --uid 10001 factos && mkdir /data && chown factos:factos /data
USER factos
ENV FACTOS_DATA_DIR=/data
EXPOSE 8000
CMD ["uvicorn", "factos.api:create_app", "--factory", "--host", "0.0.0.0", "--port", "8000", "--workers", "1"]

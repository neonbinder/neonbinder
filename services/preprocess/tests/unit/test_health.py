from fastapi.testclient import TestClient

from app.main import app

client = TestClient(app)


def test_health_returns_ok():
    response = client.get("/health")
    assert response.status_code == 200
    assert response.json() == {"status": "ok"}


def test_health_does_not_require_internal_key():
    # /health must stay unauthenticated so Cloud Run health probes pass.
    response = client.get("/health")
    assert response.status_code == 200

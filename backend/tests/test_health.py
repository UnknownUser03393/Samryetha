def test_health_ok(client):
    res = client.get("/api/health")
    assert res.status_code == 200
    body = res.json()
    assert body["status"] == "ok"
    assert body["db"] == "ok"
    assert isinstance(body["uptime"], int)


def test_health_with_db(client):
    # 健康检查不依赖 auth
    res = client.get("/api/health")
    assert res.status_code == 200
    assert res.json()["status"] == "ok"

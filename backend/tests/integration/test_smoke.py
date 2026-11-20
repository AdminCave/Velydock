from __future__ import annotations

from tests.conftest import World
from velydock.models import Role


async def test_health_and_me(world: World) -> None:
    async with world.client() as anonymous:
        assert (await anonymous.get("/api/health")).json()["status"] == "ok"
        assert (await anonymous.get("/api/v1/me")).status_code == 401
        public = await anonymous.get("/api/v1/public")
        assert public.status_code == 200, public.text
        assert public.json()["instance_name"] == "Velydock"

    acme = await world.tenant("Acme")
    admin = await world.user(acme, "anna", Role.TENANT_ADMIN)
    async with await world.login(admin) as client:
        response = await client.get("/api/v1/me")
        assert response.status_code == 200, response.text
        body = response.json()
        assert body["user"]["username"] == "anna"
        assert body["active_tenant"]["slug"] == "acme"
        assert body["role"] == "tenant_admin"
        assert "apps:manage" in body["permissions"]
        assert "system:admin" not in body["permissions"]
        users = await client.get("/api/v1/admin/users")
        assert users.status_code == 200, users.text
        assert [u["username"] for u in users.json()["items"]] == ["anna"]
        assert (await client.get("/api/v1/system/tenants")).status_code == 403
        assert (await client.get("/api/v1/nope")).status_code == 404

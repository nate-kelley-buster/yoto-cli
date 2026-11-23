import { afterEach, beforeEach, expect, mock, spyOn, test } from "bun:test";
import { chmod, mkdtemp, readdir, rm, stat } from "fs/promises";
import * as os from "os";
import { dirname, join } from "path";
import { getAuthenticatedClient, status } from "./auth.ts";
import { listPlaylists } from "./content.ts";
import { getConfigPath, loadConfig, saveConfig } from "../utils/config.ts";

let home: string;

beforeEach(async () => {
  home = await mkdtemp(join(os.tmpdir(), "yoto-auth-test-"));
  spyOn(os, "homedir").mockReturnValue(home);
  expect(getConfigPath()).toBe(join(home, ".yoto-cli", "config.json"));
});

afterEach(async () => {
  mock.restore();
  await rm(home, { recursive: true, force: true });
});

function mockFetch(handler: (...args: Parameters<typeof fetch>) => Promise<Response>) {
  return spyOn(globalThis, "fetch").mockImplementation(Object.assign(handler, { preconnect: () => {} }));
}

function jwt(expiryOffsetSeconds: number): string {
  const header = Buffer.from(JSON.stringify({ alg: "RS256" })).toString("base64url");
  const exp = Math.floor(Date.now() / 1000) + expiryOffsetSeconds;
  const payload = Buffer.from(JSON.stringify({ exp })).toString("base64url");
  return `${header}.${payload}.signature`;
}

const clientId = "fixture-client";
const refreshToken = "fixture-refresh";

function refreshResponse(accessToken: string): Response {
  return Response.json({ access_token: accessToken, refresh_token: "rotated-refresh" });
}

test("playlist list refreshes an expired JWT before it can receive a 403 and saves both tokens", async () => {
  const accessToken = jwt(-60);
  const freshToken = jwt(3600);
  const config = { clientId, accessToken, refreshToken, legacyField: true };
  await saveConfig(config);
  if (process.platform !== "win32") await chmod(getConfigPath(), 0o644);
  const originalFile = await stat(getConfigPath());

  const requests: string[] = [];
  mockFetch(async (url, options) => {
    const path = new URL(String(url)).pathname;
    requests.push(path);
    if (path === "/oauth/token") {
      expect(options?.body?.toString()).toBe(new URLSearchParams({
        client_id: clientId, grant_type: "refresh_token", refresh_token: refreshToken,
      }).toString());
      return refreshResponse(freshToken);
    }
    if (new Headers(options?.headers).get("Authorization") !== `Bearer ${freshToken}`) {
      return new Response(null, { status: 403 });
    }
    expect(await loadConfig()).toEqual({ ...config, accessToken: freshToken, refreshToken: "rotated-refresh" });
    return Response.json({ cards: [] });
  });
  const log = spyOn(console, "log").mockImplementation(() => {});

  await listPlaylists({ json: true });
  expect(log).toHaveBeenCalledWith("[]");
  expect(requests).toEqual(["/oauth/token", "/content/mine"]);
  if (process.platform !== "win32") {
    const savedFile = await stat(getConfigPath());
    expect(savedFile.mode & 0o777).toBe(0o600);
    expect(savedFile.ino).not.toBe(originalFile.ino);
  }
});

test("status refreshes a JWT within the expiry buffer", async () => {
  const freshToken = jwt(3600);
  await saveConfig({ clientId, accessToken: jwt(15), refreshToken });
  const fetchMock = mockFetch(async (url, options) => {
    if (new URL(String(url)).pathname === "/oauth/token") return refreshResponse(freshToken);
    expect(new Headers(options?.headers).get("Authorization")).toBe(`Bearer ${freshToken}`);
    return Response.json({ cards: [] });
  });
  const log = spyOn(console, "log").mockImplementation(() => {});

  await status();
  expect(log).toHaveBeenCalledWith("✓ Logged in and token is valid.");
  expect(fetchMock).toHaveBeenCalledTimes(2);
  expect((await loadConfig())?.refreshToken).toBe("rotated-refresh");
});

test.each([jwt(3600), "opaque-token", "invalid.invalid.signature"])(
  "uses a fresh or unreadable access token on the first request (%s)", async (accessToken) => {
    await saveConfig({ clientId, accessToken, refreshToken });
    const fetchMock = mockFetch(async (url, options) => {
      expect(new URL(String(url)).pathname).toBe("/content/mine");
      expect(new Headers(options?.headers).get("Authorization")).toBe(`Bearer ${accessToken}`);
      return Response.json({ cards: [] });
    });

    expect(await (await getAuthenticatedClient()).listContent()).toEqual({ cards: [] });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect((await loadConfig())?.refreshToken).toBe(refreshToken);
  }
);

test.each([200, 401])("refreshes and retries a 401 only once (retry status %s)", async (retryStatus) => {
  const accessToken = "opaque-access";
  const freshToken = jwt(3600);
  await saveConfig({ clientId, accessToken, refreshToken });
  const requests: string[] = [];
  mockFetch(async (url, options) => {
    if (new URL(String(url)).pathname === "/oauth/token") {
      requests.push("refresh");
      return refreshResponse(freshToken);
    }
    const authorization = new Headers(options?.headers).get("Authorization");
    requests.push(authorization ?? "missing");
    if (authorization === `Bearer ${accessToken}`) return new Response(null, { status: 401 });
    return Response.json({ cards: [] }, { status: retryStatus });
  });

  const request = (await getAuthenticatedClient()).listContent();
  if (retryStatus === 200) await expect(request).resolves.toEqual({ cards: [] });
  else await expect(request).rejects.toThrow("Authentication expired");
  expect(requests).toEqual([`Bearer ${accessToken}`, "refresh", `Bearer ${freshToken}`]);
  expect(await loadConfig()).toEqual({ clientId, accessToken: freshToken, refreshToken: "rotated-refresh" });
});

test("status surfaces a genuine 403 without refreshing", async () => {
  await saveConfig({ clientId, accessToken: jwt(3600), refreshToken });
  const fetchMock = spyOn(globalThis, "fetch").mockResolvedValue(new Response("Forbidden", { status: 403 }));

  await expect(status()).rejects.toThrow("403 (Forbidden)");
  expect(fetchMock).toHaveBeenCalledTimes(1);
  expect((await loadConfig())?.refreshToken).toBe(refreshToken);
});

test("independent clients with stale config share one single-use refresh", async () => {
  const freshToken = jwt(3600);
  await saveConfig({ clientId, accessToken: jwt(-60), refreshToken });
  const first = await getAuthenticatedClient();
  const second = await getAuthenticatedClient();
  let refreshes = 0;
  const fetchMock = mockFetch(async (url, options) => {
    if (new URL(String(url)).pathname === "/oauth/token") {
      refreshes++;
      await Bun.sleep(80);
      return refreshResponse(freshToken);
    }
    expect(new Headers(options?.headers).get("Authorization")).toBe(`Bearer ${freshToken}`);
    return Response.json({ cards: [] });
  });

  await Promise.all([first.listContent(), second.listContent()]);
  expect(refreshes).toBe(1);
  expect(fetchMock).toHaveBeenCalledTimes(3);
  expect(await loadConfig()).toEqual({ clientId, accessToken: freshToken, refreshToken: "rotated-refresh" });
});

test("a stale client cannot refresh into a different login session", async () => {
  await saveConfig({ clientId, accessToken: jwt(-60), refreshToken });
  const client = await getAuthenticatedClient();
  const newSession = { clientId, accessToken: jwt(3600), refreshToken: "other-refresh", sessionId: "new-session" };
  await saveConfig(newSession);
  const fetchMock = mockFetch(async () => { throw new Error("Unexpected request"); });

  await expect(client.listContent()).rejects.toThrow("Yoto login credentials changed");
  expect(fetchMock).not.toHaveBeenCalled();
  expect(await loadConfig()).toEqual(newSession);
});

test("an authenticated upload refreshes first and keeps its original method, content type, and body", async () => {
  const freshToken = jwt(3600);
  const file = new Uint8Array([1, 2, 3]);
  await saveConfig({ clientId, accessToken: jwt(-60), refreshToken });
  const fetchMock = mockFetch(async (url, options) => {
    if (new URL(String(url)).pathname === "/oauth/token") return refreshResponse(freshToken);
    expect(new URL(String(url)).pathname).toBe("/media/coverImage/user/me/upload");
    const headers = new Headers(options?.headers);
    expect(headers.get("Authorization")).toBe(`Bearer ${freshToken}`);
    expect(headers.get("Content-Type")).toBe("image/png");
    expect(options?.method).toBe("POST");
    expect(options?.body).toBe(file);
    return Response.json({ coverImage: { mediaUrl: "https://example.test/cover" } });
  });

  await (await getAuthenticatedClient()).uploadCoverImage(file, { filename: "cover.png" });
  expect(fetchMock).toHaveBeenCalledTimes(2);
});

test("a failed refresh leaves the config intact and keeps provider details out of the error", async () => {
  const config = { clientId, accessToken: jwt(-60), refreshToken };
  await saveConfig(config);
  const fetchMock = spyOn(globalThis, "fetch").mockResolvedValue(Response.json({
    error: "invalid_grant", error_description: `Rejected token ${refreshToken}`,
  }, { status: 400 }));

  await expect((await getAuthenticatedClient()).listContent()).rejects.toThrow(
    new Error("Yoto token refresh failed (HTTP 400).")
  );
  expect(fetchMock).toHaveBeenCalledTimes(1);
  expect(await loadConfig()).toEqual(config);
  expect((await readdir(dirname(getConfigPath()))).sort()).toEqual(["config.json", "config.lock"]);
});

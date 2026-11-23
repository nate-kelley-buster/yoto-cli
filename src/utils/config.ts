import { Database, SQLiteError } from "bun:sqlite";
import { randomUUID } from "crypto";
import { homedir } from "os";
import { dirname, join } from "path";
import { mkdir, open, readFile, rename, unlink } from "fs/promises";
import type { Credentials } from "../api/client.ts";

export interface Config {
  clientId: string;
  accessToken?: string;
  refreshToken?: string;
  sessionId?: string;
}

async function withConfigLock<T>(action: () => Promise<T>): Promise<T> {
  const directory = dirname(getConfigPath());
  await mkdir(directory, { recursive: true, mode: 0o700 });

  // An empty SQLite transaction provides a cross-process lock that is released
  // automatically if a process exits. Credentials stay in config.json.
  const lock = new Database(join(directory, "config.lock"));
  try {
    const deadline = Date.now() + 20_000;
    while (true) {
      try {
        lock.exec("BEGIN IMMEDIATE");
        break;
      } catch (err) {
        if (!(err instanceof SQLiteError) || err.code !== "SQLITE_BUSY") throw err;
        if (Date.now() >= deadline) throw new Error("Timed out waiting for the Yoto config lock.");
        await Bun.sleep(50);
      }
    }
    return await action();
  } finally {
    lock.close();
  }
}

async function writeConfig<T extends Config | Record<string, never>>(
  prepare: () => T | Promise<T>
): Promise<T> {
  const path = getConfigPath();
  const tempPath = `${path}.${randomUUID()}.tmp`;
  const file = await open(tempPath, "wx", 0o600);
  try {
    // Open the replacement before making a single-use refresh request.
    let config: T;
    try {
      config = await prepare();
      await file.writeFile(JSON.stringify(config, null, 2));
      await file.sync();
    } finally {
      await file.close();
    }
    await rename(tempPath, path);
    return config;
  } catch (err) {
    await unlink(tempPath).catch(() => {});
    throw err;
  }
}

export async function loadConfig(): Promise<Config | null> {
  try {
    const data = await readFile(getConfigPath(), "utf-8");
    return JSON.parse(data);
  } catch {
    return null;
  }
}

export async function saveConfig(config: Config): Promise<void> {
  await withConfigLock(() => writeConfig(() => config));
}

export async function clearConfig(): Promise<void> {
  await withConfigLock(() => writeConfig(() => ({})));
}

export async function refreshSavedCredentials(
  config: Config,
  previous: Credentials,
  refresh: () => Promise<Credentials>
): Promise<Credentials> {
  return withConfigLock(async () => {
    const current = await loadConfig();
    if (
      !current?.accessToken || !current.refreshToken ||
      current.clientId !== config.clientId || current.sessionId !== config.sessionId
    ) {
      throw new Error("Yoto login credentials changed. Run the command again.");
    }

    if (current.accessToken !== previous.accessToken || current.refreshToken !== previous.refreshToken) {
      return { accessToken: current.accessToken, refreshToken: current.refreshToken };
    }

    return writeConfig(async () => ({ ...current, ...(await refresh()) }));
  });
}

export function getConfigPath(): string {
  return join(homedir(), ".yoto-cli", "config.json");
}

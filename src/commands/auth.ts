import { randomUUID } from "crypto";
import { YotoClient, requestTokenRefresh } from "../api/client.ts";
import {
  loadConfig,
  saveConfig,
  clearConfig,
  getConfigPath,
  refreshSavedCredentials,
  type Config,
} from "../utils/config.ts";
import { success, error, info } from "../utils/output.ts";

const CLIENT_ID = "A1c4Noo77MdN7CB8QjUOvwtdyMZnSwkd";

export async function login(): Promise<void> {
  const client = new YotoClient({ clientId: CLIENT_ID });

  info("Starting device authorization flow...");

  const deviceCode = await client.initDeviceFlow();

  console.log("\nTo authorize this CLI:");
  console.log(`1. Go to: ${deviceCode.verification_uri_complete}`);
  console.log(
    `   Or visit ${deviceCode.verification_uri} and enter code: ${deviceCode.user_code}`
  );
  console.log("\n2. Log in with your Yoto account and approve access\n");

  info("Waiting for authorization...");

  const pollInterval = (deviceCode.interval || 5) * 1000;
  const expiresAt = Date.now() + deviceCode.expires_in * 1000;

  while (Date.now() < expiresAt) {
    await new Promise((resolve) => setTimeout(resolve, pollInterval));

    try {
      const tokens = await client.pollForToken(deviceCode.device_code);

      await saveConfig({
        clientId: CLIENT_ID,
        accessToken: tokens.access_token,
        refreshToken: tokens.refresh_token,
        sessionId: randomUUID(),
      });

      success("Successfully logged in!");
      info(`Config saved to ${getConfigPath()}`);
      return;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (message === "authorization_pending" || message === "slow_down") {
        process.stdout.write(".");
        continue;
      }
      throw err;
    }
  }

  error("Authorization timed out. Please try again.");
  process.exit(1);
}

export async function logout(): Promise<void> {
  await clearConfig();
  success("Logged out. Credentials removed.");
}

export async function status(): Promise<void> {
  const config = await loadConfig();

  if (!config?.accessToken) {
    info("Not logged in. Run 'yoto login' to authenticate.");
    return;
  }

  await clientFromConfig(config).listContent();
  success("Logged in and token is valid.");
}

export async function getAuthenticatedClient(): Promise<YotoClient> {
  const config = await loadConfig();

  if (!config?.accessToken) {
    error("Not logged in. Run 'yoto login' first.");
    process.exit(1);
  }

  return clientFromConfig(config);
}

function clientFromConfig(config: Config): YotoClient {
  return new YotoClient(config, (previous) =>
    refreshSavedCredentials(config, previous, () =>
      requestTokenRefresh(config.clientId, previous.refreshToken)
    )
  );
}

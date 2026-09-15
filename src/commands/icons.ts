import { readFile } from "fs/promises";
import { basename } from "path";
import { getAuthenticatedClient } from "./auth.ts";
import { success, info, table, json } from "../utils/output.ts";

export async function listPublicIcons(options: {
  json?: boolean;
  tag?: string;
}): Promise<void> {
  const client = await getAuthenticatedClient();
  const response = await client.getPublicIcons();

  let icons = response.displayIcons;

  if (options.tag) {
    icons = icons.filter((icon) =>
      icon.publicTags.some((t) =>
        t.toLowerCase().includes(options.tag!.toLowerCase())
      )
    );
  }

  if (options.json) {
    json(icons);
    return;
  }

  if (icons.length === 0) {
    info("No icons found.");
    return;
  }

  table(
    ["Title", "Media ID", "Tags"],
    icons.map((icon) => [icon.title ?? "", icon.mediaId, icon.publicTags.join(", ")])
  );
}

export async function listUserIcons(options: { json?: boolean }): Promise<void> {
  const client = await getAuthenticatedClient();
  const response = await client.getUserIcons();

  if (options.json) {
    json(response.displayIcons);
    return;
  }

  if (response.displayIcons.length === 0) {
    info("No custom icons found.");
    return;
  }

  table(
    ["Media ID", "URL"],
    response.displayIcons.map((icon) => [icon.mediaId, icon.url])
  );
}

export async function uploadIcon(
  filePath: string,
  options: { autoConvert?: boolean; json?: boolean }
): Promise<void> {
  const client = await getAuthenticatedClient();
  const file = await readFile(filePath);
  const filename = basename(filePath);

  const response = await client.uploadIcon(file, {
    filename,
    autoConvert: options.autoConvert ?? true,
  });

  if (options.json) {
    json(response.displayIcon);
    return;
  }

  const icon = response.displayIcon;
  success(`Uploaded icon: ${icon.mediaId}`);
  if (typeof icon.url === "string" && icon.url) {
    info(`URL: ${icon.url}`);
  }
}

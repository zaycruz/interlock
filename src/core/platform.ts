import { UnsupportedPlatformError } from "./errors.js";

const SUPPORTED_PLATFORMS = new Set<NodeJS.Platform>(["darwin", "linux"]);

export function assertSupportedPlatform(platform: NodeJS.Platform = process.platform): void {
  if (!SUPPORTED_PLATFORMS.has(platform)) {
    throw new UnsupportedPlatformError(platform);
  }
}

import { execFile, spawn } from "node:child_process";
import { accessSync, constants, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const DOWNLOAD_TIMEOUT_MS = 60_000;
const FRAME_TIMEOUT_MS = 60_000;

/** ffmpeg candidates the daemon can reach regardless of its PATH. */
export function resolveFfmpeg(): string | null {
  for (const candidate of ["/opt/homebrew/bin/ffmpeg", "/usr/local/bin/ffmpeg"]) {
    try {
      accessSync(candidate, constants.X_OK);
      return candidate;
    } catch {
      // Try the next candidate.
    }
  }
  return null;
}

/**
 * Download one message resource (image or file) via lark-cli into a temp
 * directory and return its bytes. Caller is responsible for cleanup.
 */
export async function downloadMessageResource(options: {
  cliPath: string;
  messageId: string;
  fileKey: string;
  type: "image" | "file";
}): Promise<{ bytes: Buffer; extension: string }> {
  const dir = mkdtempSync(join(tmpdir(), "lark-bot-media-"));
  try {
    const output = join(dir, "resource");
    await execFileAsync(
      options.cliPath,
      [
        "im",
        "+messages-resources-download",
        "--message-id",
        options.messageId,
        "--file-key",
        options.fileKey,
        "--type",
        options.type,
        "--output",
        output,
        "--as",
        "bot",
      ],
      { timeout: DOWNLOAD_TIMEOUT_MS, maxBuffer: 1024 * 1024 },
    );
    const files = readdirSync(dir).filter((name) => name.startsWith("resource"));
    if (files.length === 0) throw new Error("下载结果为空");
    const name = files[0];
    return {
      bytes: readFileSync(join(dir, name)),
      extension: name.slice(name.lastIndexOf(".")) || "",
    };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * Pull a handful of evenly-spaced frames from a video as JPEG buffers so
 * vision-capable providers can "see" it. Scaled down to keep prompt sizes
 * sane; failures degrade to zero frames.
 */
export async function extractVideoFrames(
  videoPath: string,
  ffmpeg: string,
  maxFrames = 3,
): Promise<Buffer[]> {
  const dir = mkdtempSync(join(tmpdir(), "lark-bot-frames-"));
  try {
    const child = spawn(
      ffmpeg,
      [
        "-hide_banner",
        "-loglevel",
        "error",
        "-i",
        videoPath,
        "-vf",
        `fps=1/4,scale=640:-2`,
        "-frames:v",
        String(maxFrames),
        "-q:v",
        "5",
        join(dir, "frame-%02d.jpg"),
      ],
      { stdio: ["ignore", "ignore", "pipe"] },
    );
    const done = new Promise<void>((resolve, reject) => {
      child.on("error", reject);
      child.on("exit", (code) => (code === 0 ? resolve() : reject(new Error("ffmpeg 退出码 " + code))));
    });
    const timeout = new Promise<"timeout">((resolve) => {
      setTimeout(() => resolve("timeout"), FRAME_TIMEOUT_MS).unref?.();
    });
    if ((await Promise.race([done.then(() => "done" as const), timeout])) === "timeout") {
      child.kill("SIGKILL");
      return [];
    }
    await done.catch(() => undefined);
    return readdirSync(dir)
      .filter((name) => name.endsWith(".jpg"))
      .sort()
      .map((name) => readFileSync(join(dir, name)));
  } catch {
    return [];
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** JPEG frames can be large; drop obviously oversized payloads. */
export function toImageAttachment(bytes: Buffer, mimeType: string): { data: string; mimeType: string } | null {
  const MAX_BYTES = 5 * 1024 * 1024;
  if (bytes.length === 0 || bytes.length > MAX_BYTES) return null;
  return { data: bytes.toString("base64"), mimeType };
}

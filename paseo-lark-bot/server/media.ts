import { execFile, spawn } from "node:child_process";
import { accessSync, constants, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
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
  maxBytes?: number;
}): Promise<{ bytes: Buffer; extension: string }> {
  const maxBytes = options.maxBytes ?? 50 * 1024 * 1024;
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
    const path = join(dir, name);
    const size = statSync(path).size;
    if (size > maxBytes) {
      throw new Error(`下载资源过大（${Math.ceil(size / 1024 / 1024)}MB，上限 ${Math.ceil(maxBytes / 1024 / 1024)}MB）`);
    }
    return {
      bytes: readFileSync(path),
      extension: name.slice(name.lastIndexOf(".")) || "",
    };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** Probe the container duration; return null when ffprobe is unavailable. */
async function probeDurationSeconds(videoPath: string, ffmpeg: string): Promise<number | null> {
  const ffprobe = ffmpeg.replace(/ffmpeg(\.exe)?$/i, "ffprobe$1");
  try {
    const { stdout } = await execFileAsync(
      ffprobe,
      ["-v", "error", "-show_entries", "format=duration", "-of", "default=noprint_wrappers=1:nokey=1", videoPath],
      { timeout: 15_000, maxBuffer: 64 * 1024 },
    );
    const seconds = Number(stdout.trim());
    return Number.isFinite(seconds) && seconds > 0 ? seconds : null;
  } catch {
    return null;
  }
}

async function captureFrame(ffmpeg: string, videoPath: string, atSeconds: number, output: string): Promise<void> {
  const child = spawn(
    ffmpeg,
    [
      "-hide_banner",
      "-loglevel",
      "error",
      "-ss",
      String(atSeconds),
      "-i",
      videoPath,
      "-frames:v",
      "1",
      "-vf",
      "scale=640:-2",
      "-q:v",
      "5",
      output,
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
  void done.catch(() => undefined);
  if ((await Promise.race([done.then(() => "done" as const), timeout])) === "timeout") {
    child.kill("SIGKILL");
    throw new Error("ffmpeg 抽帧超时");
  }
  await done.catch(() => undefined);
}

/**
 * Pull evenly-spaced frames across the whole video as JPEG buffers so
 * vision-capable providers can "see" more than the opening seconds. Scaled
 * down to keep prompt sizes sane; failures degrade to zero frames.
 */
export async function extractVideoFrames(
  videoPath: string,
  ffmpeg: string,
  maxFrames = 3,
): Promise<Buffer[]> {
  const dir = mkdtempSync(join(tmpdir(), "lark-bot-frames-"));
  try {
    const duration = await probeDurationSeconds(videoPath, ffmpeg);
    const fractions = maxFrames === 1 ? [0.5] : [0.15, 0.5, 0.85];
    const times = duration
      ? fractions.slice(0, maxFrames).map((fraction) => duration * fraction)
      : Array.from({ length: maxFrames }, (_, index) => index * 4);
    await Promise.allSettled(
      times.map((seconds, index) => captureFrame(ffmpeg, videoPath, seconds, join(dir, `frame-${index}.jpg`))),
    );
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

/** Keep a path segment safe for the on-disk media layout. */
function safeSegment(value: string): string {
  const cleaned = value.replace(/[^a-zA-Z0-9._-]/g, "_");
  return cleaned.slice(0, 80) || "topic";
}

/**
 * Persist an ingested image under `<root>/<topicKey>/<messageId>-<n><ext>`
 * and return the absolute path; failures return null (the base64 attachment
 * still reaches the provider, only the file copy is skipped).
 */
export function persistMediaFile(
  root: string,
  topicKey: string,
  messageId: string,
  index: number,
  bytes: Buffer,
  extension: string,
): string | null {
  try {
    const dir = join(root, safeSegment(topicKey));
    mkdirSync(dir, { recursive: true });
    const path = join(dir, `${safeSegment(messageId)}-${index}${extension}`);
    writeFileSync(path, bytes);
    return path;
  } catch {
    return null;
  }
}

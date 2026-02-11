import fs from "fs";
import path from "path";
import { spawn } from "child_process";
import { fileURLToPath } from "url";
import { ResultAsync } from "neverthrow";
import { loadEnv } from "./env";
import { uploadHlsDir } from "../uploader/upload";

type EventStatus =
  | "torrent_downloaded"
  | "hls_generating"
  | "hls_uploaded"
  | "cleanup_done"
  | "failed";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const env = unwrapOrExit(loadEnv());

const credentials = {
  accessKeyId: env.accessKeyId,
  secretAccessKey: env.secretAccessKey,
  endpoint: env.endpoint,
  bucket: env.bucket,
};

const workRoot = path.resolve(__dirname, "..", env.workDir);
const hlsRoot = path.join(workRoot, "hls");
await fs.promises.mkdir(hlsRoot, { recursive: true });

const inputPath = process.argv[2];
if (!inputPath) {
  console.error("Usage: bun run index.ts <path-to-video>");
  process.exit(1);
}

const torrentKey = process.argv[3] ?? path.basename(inputPath);
const id = encodeHlsId(torrentKey);
const outputDir = path.join(hlsRoot, id);
await fs.promises.mkdir(outputDir, { recursive: true });

await publishStatus({
  id,
  status: "torrent_downloaded",
  torrentKey,
});

await publishStatus({
  id,
  status: "hls_generating",
  torrentKey,
});

const playlistPath = path.join(outputDir, "index.m3u8");
await runFfmpeg(inputPath, outputDir, playlistPath);

const prefix = `${env.hlsPrefix}/${id}`;
await unwrapOrExitAsync(
  ResultAsync.fromPromise(
    uploadHlsDir({
      hlsDir: outputDir,
      prefix,
      concurrency: 2,
      credentials,
    }),
    (error) => toError("Upload failed.", error),
  ),
);

await publishStatus({
  id,
  status: "hls_uploaded",
  torrentKey,
  hlsKey: `${prefix}/index.m3u8`,
});

await fs.promises.rm(outputDir, { recursive: true, force: true });

await publishStatus({
  id,
  status: "cleanup_done",
  torrentKey,
  hlsKey: `${prefix}/index.m3u8`,
});

console.log("Done.");

async function publishStatus(payload: {
  id: string;
  status: EventStatus;
  torrentKey: string;
  hlsKey?: string;
}) {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };
  if (env.queueBackendToken) {
    headers.Authorization = `Bearer ${env.queueBackendToken}`;
  }

  const response = await fetch(env.queueBackendUrl, {
    method: "POST",
    headers,
    body: JSON.stringify(payload),
  });

  if (!response.ok) {
    throw new Error(`Queue backend error: ${response.status} ${response.statusText}`);
  }
}

async function runFfmpeg(inputPath: string, outputDir: string, playlist: string) {
  await new Promise<void>((resolve, reject) => {
    const segmentPattern = path.join(outputDir, "%03d.ts");
    const segmentSeconds = 2;
    const args = [
      "-i",
      inputPath,
      "-preset",
      "veryfast",
      "-c:v",
      "libx264",
      "-profile:v",
      "main",
      "-level",
      "4.1",
      "-pix_fmt",
      "yuv420p",
      "-crf",
      "23",
      "-maxrate",
      "3500k",
      "-bufsize",
      "7000k",
      "-g",
      "48",
      "-keyint_min",
      "48",
      "-sc_threshold",
      "0",
      "-force_key_frames",
      `expr:gte(t,n_forced*${segmentSeconds})`,
      "-c:a",
      "aac",
      "-b:a",
      "128k",
      "-ac",
      "2",
      "-hls_time",
      String(segmentSeconds),
      "-hls_list_size",
      "0",
      "-hls_playlist_type",
      "vod",
      "-hls_flags",
      "independent_segments",
      "-hls_segment_filename",
      segmentPattern,
      playlist,
    ];

    const proc = spawn("ffmpeg", args, { stdio: "inherit" });
    proc.on("error", reject);
    proc.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`ffmpeg exited with code ${code}`));
    });
  });
}

function encodeHlsId(value: string) {
  return Buffer.from(value).toString("base64url");
}

function unwrapOrExit<T>(result: { isOk(): boolean; value: T; error: Error }) {
  if (result.isOk()) return result.value;
  console.error(result.error.message);
  process.exit(1);
}

async function unwrapOrExitAsync<T>(
  result: Promise<{ isOk(): boolean; value: T; error: Error }>,
) {
  const resolved = await result;
  if (resolved.isOk()) return resolved.value;
  console.error(resolved.error.message);
  process.exit(1);
}

function toError(message: string, error: unknown) {
  if (error instanceof Error) {
    return new Error(`${message} ${error.message}`);
  }
  return new Error(`${message} ${String(error)}`);
}

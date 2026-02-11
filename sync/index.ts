import fs from "fs";
import path from "path";
import { spawn } from "child_process";
import { fileURLToPath } from "url";
import { ResultAsync } from "neverthrow";
import { loadEnv } from "./env";
import { uploadHlsDir } from "../uploader/upload";

type MappingEntry = {
  torrentKey: string;
  hlsId: string;
  playlistKey: string;
  uploadedAt: string;
};

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const env = unwrapOrExit(loadEnv());

const credentials = {
  accessKeyId: env.accessKeyId,
  secretAccessKey: env.secretAccessKey,
  endpoint: env.endpoint,
  bucket: env.bucket,
};

const client = new Bun.S3Client(credentials);

const workRoot = path.resolve(__dirname, "..", env.workDir);
const downloadDir = path.join(workRoot, "downloads");
const hlsRoot = path.join(workRoot, "hls");
const mappingsPath = path.join(__dirname, "mappings.json");

await fs.promises.mkdir(downloadDir, { recursive: true });
await fs.promises.mkdir(hlsRoot, { recursive: true });

console.log("Sync worker started.");

while (true) {
  const batch = await unwrapOrExitAsync(
    ResultAsync.fromPromise(
      pullBatch(),
      (error) => toError("Failed to pull queue messages.", error),
    ),
  );

  if (batch.messages.length === 0) {
    await sleep(env.pollMs);
    continue;
  }

  const ackIds: string[] = [];
  const retryIds: string[] = [];

  for (const message of batch.messages) {
    const key = resolveTorrentKey(message.body);
    if (!key) {
      retryIds.push(message.id);
      continue;
    }

    try {
      await processTorrent(key);
      ackIds.push(message.id);
    } catch (error) {
      console.error(`Failed processing ${key}:`, error);
      retryIds.push(message.id);
    }
  }

  if (ackIds.length || retryIds.length) {
    await unwrapOrExitAsync(
      ResultAsync.fromPromise(
        ackBatch({ ackIds, retryIds }),
        (error) => toError("Failed to ack queue messages.", error),
      ),
    );
  }
}

async function processTorrent(key: string) {
  console.log(`Processing ${key}...`);

  const id = encodeHlsId(key);
  const filename = path.basename(key);
  const localVideoDir = path.join(downloadDir, id);
  const localVideoPath = path.join(localVideoDir, filename);
  const outputDir = path.join(hlsRoot, id);

  await fs.promises.mkdir(localVideoDir, { recursive: true });
  await fs.promises.mkdir(outputDir, { recursive: true });

  await downloadObjectWithProgress(key, localVideoPath);

  const playlistPath = path.join(outputDir, "index.m3u8");
  await runFfmpeg(localVideoPath, outputDir, playlistPath);

  const prefix = `${env.hlsPrefix}/${id}`;
  await unwrapOrExitAsync(
    ResultAsync.fromPromise(
      uploadHlsDir({
        hlsDir: outputDir,
        prefix,
        concurrency: env.concurrency,
        credentials,
      }),
      (error) => toError("Upload failed.", error),
    ),
  );

  await upsertMapping({
    torrentKey: key,
    hlsId: id,
    playlistKey: `${prefix}/index.m3u8`,
    uploadedAt: new Date().toISOString(),
  });

  await client.delete(key);

  await fs.promises.rm(localVideoDir, { recursive: true, force: true });
  await fs.promises.rm(outputDir, { recursive: true, force: true });

  console.log(`Done: ${key}`);
}

async function downloadObjectWithProgress(key: string, outputPath: string) {
  const s3File = client.file(key);
  let total = 0;
  try {
    const stat = await s3File.stat();
    total = typeof stat.size === "number" ? stat.size : 0;
  } catch {
    total = 0;
  }

  const stream = s3File.stream();
  const writer = fs.createWriteStream(outputPath);
  let downloaded = 0;
  let lastTick = 0;

  const label = `Downloading ${path.basename(key)}`;
  const render = (force = false) => {
    const now = Date.now();
    if (!force && now - lastTick < 250) return;
    lastTick = now;
    if (total > 0) {
      const pct = Math.min(100, Math.round((downloaded / total) * 100));
      process.stdout.write(`\r${label} ${pct}%`);
    } else {
      process.stdout.write(`\r${label} ${formatBytes(downloaded)}`);
    }
  };

  try {
    for await (const chunk of stream) {
      const buf = Buffer.from(chunk);
      downloaded += buf.length;
      writer.write(buf);
      render();
    }
    writer.end();
    render(true);
    process.stdout.write("\n");
  } catch (error) {
    writer.end();
    process.stdout.write("\n");
    throw error;
  }
}

function formatBytes(bytes: number) {
  if (bytes < 1024) return `${bytes}B`;
  const units = ["KB", "MB", "GB", "TB"];
  let value = bytes / 1024;
  let unitIndex = 0;
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }
  return `${value.toFixed(1)}${units[unitIndex]}`;
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

async function pullBatch() {
  const url = `https://api.cloudflare.com/client/v4/accounts/${env.accountId}/queues/${env.queueId}/messages/pull`;
  const response = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${env.apiToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      batch_size: env.batchSize,
      visibility_timeout_ms: env.visibilityTimeoutMs,
    }),
  });

  if (!response.ok) {
    throw new Error(`Queue pull failed: ${response.status} ${response.statusText}`);
  }

  const data = await response.json();
  if (!data?.success) {
    throw new Error(`Queue pull error: ${JSON.stringify(data?.errors ?? [])}`);
  }

  return {
    messages: (data.result?.messages ?? []).map((message: any) => ({
      id: message.id as string,
      body: message.body,
    })),
  };
}

async function ackBatch(payload: { ackIds: string[]; retryIds: string[] }) {
  const url = `https://api.cloudflare.com/client/v4/accounts/${env.accountId}/queues/${env.queueId}/messages/ack`;
  const response = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${env.apiToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      ack_messages: payload.ackIds,
      retry_messages: payload.retryIds,
    }),
  });

  if (!response.ok) {
    throw new Error(`Queue ack failed: ${response.status} ${response.statusText}`);
  }

  const data = await response.json();
  if (!data?.success) {
    throw new Error(`Queue ack error: ${JSON.stringify(data?.errors ?? [])}`);
  }
}

function resolveTorrentKey(body: unknown) {
  if (!body) return null;
  if (typeof body === "object" && body !== null) {
    const candidate = body as { key?: string };
    return candidate.key ?? null;
  }
  if (typeof body === "string") {
    try {
      const decoded = Buffer.from(body, "base64").toString("utf8");
      const parsed = JSON.parse(decoded) as { key?: string };
      return parsed.key ?? null;
    } catch {
      return null;
    }
  }
  return null;
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function upsertMapping(entry: MappingEntry) {
  let current: MappingEntry[] = [];
  try {
    const raw = await fs.promises.readFile(mappingsPath, "utf8");
    current = JSON.parse(raw) as MappingEntry[];
  } catch {
    current = [];
  }

  current.push(entry);
  await fs.promises.writeFile(mappingsPath, JSON.stringify(current, null, 2));
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

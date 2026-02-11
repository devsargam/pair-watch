import path from "path";
import { runWithConcurrency, walkFiles } from "./utils";

type Credentials = {
  accessKeyId: string;
  secretAccessKey: string;
  endpoint: string;
  bucket: string;
};

type UploadCallbacks = {
  onStart?: (name: string) => void;
  onSuccess?: (name: string) => void;
  onFail?: (name: string) => void;
  onSkipped?: (count: number) => void;
};

export type UploadResult = {
  uploaded: string[];
  skipped: number;
};

export async function uploadHlsDir(options: {
  hlsDir: string;
  prefix?: string;
  concurrency: number;
  credentials: Credentials;
  callbacks?: UploadCallbacks;
}) {
  const { hlsDir, prefix, concurrency, credentials, callbacks } = options;
  const client = new Bun.S3Client(credentials);
  const files = await walkFiles(hlsDir);
  if (!files.length) {
    return { uploaded: [], skipped: 0 } satisfies UploadResult;
  }

  const existingKeys = await listAllKeys(prefix ?? "", credentials);
  const toUpload = files.filter((filePath) => {
    const relativePath = path.relative(hlsDir, filePath).replaceAll(path.sep, "/");
    const key = prefix ? `${prefix}/${relativePath}` : relativePath;
    return !existingKeys.has(key);
  });

  const skipped = files.length - toUpload.length;
  callbacks?.onSkipped?.(skipped);

  const uploaded: string[] = [];

  await runWithConcurrency(toUpload, concurrency, async (filePath) => {
    const relativePath = path.relative(hlsDir, filePath).replaceAll(path.sep, "/");
    const key = prefix ? `${prefix}/${relativePath}` : relativePath;
    const file = Bun.file(filePath);

    callbacks?.onStart?.(relativePath);
    try {
      await client.write(key, file, {
        type: contentTypeFor(filePath),
        cacheControl: cacheControlFor(filePath),
      });
      uploaded.push(relativePath);
      callbacks?.onSuccess?.(relativePath);
    } catch (error) {
      callbacks?.onFail?.(relativePath);
      throw error;
    }
  });

  return { uploaded, skipped } satisfies UploadResult;
}

function contentTypeFor(filePath: string) {
  if (filePath.endsWith(".m3u8")) return "application/vnd.apple.mpegurl";
  if (filePath.endsWith(".ts")) return "video/MP2T";
  if (filePath.endsWith(".vtt")) return "text/vtt";
  return "application/octet-stream";
}

function cacheControlFor(filePath: string) {
  if (filePath.endsWith(".m3u8")) return "no-cache";
  if (filePath.endsWith(".ts")) return "public, max-age=31536000, immutable";
  if (filePath.endsWith(".vtt")) return "public, max-age=3600";
  return "public, max-age=3600";
}

async function listAllKeys(prefix: string, credentials: Credentials) {
  const keys = new Set<string>();
  let startAfter: string | undefined;
  const listPrefix = prefix ? `${prefix}/` : undefined;

  do {
    const result = await Bun.S3Client.list(
      {
        prefix: listPrefix,
        maxKeys: 1000,
        startAfter,
      },
      credentials,
    );

    const contents = result.contents ?? [];
    for (const entry of contents) {
      if (entry.key) keys.add(entry.key);
    }

    if (result.isTruncated && contents.length > 0) {
      startAfter = contents[contents.length - 1].key;
    } else {
      startAfter = undefined;
    }
  } while (startAfter);

  return keys;
}

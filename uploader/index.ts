import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { loadEnv } from "./env";
import { runWithConcurrency, walkFiles } from "./utils";
import { selectFiles } from "./tui";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const rootDir = path.resolve(__dirname, "..");
const hlsDir = path.join(rootDir, "hls");

const env = loadEnv();

if (!fs.existsSync(hlsDir)) {
  console.error(`HLS directory not found: ${hlsDir}`);
  process.exit(1);
}

const prefix = await resolvePrefix(env.prefix);

const credentials = {
  accessKeyId: env.accessKeyId,
  secretAccessKey: env.secretAccessKey,
  bucket: env.bucket,
  endpoint: env.endpoint,
};

const client = new Bun.S3Client(credentials);

const files = await walkFiles(hlsDir);
if (!files.length) {
  console.log("No HLS files to upload.");
  process.exit(0);
}
const selectedFiles = await selectFiles(files, hlsDir);
if (!selectedFiles.length) {
  console.log("No files selected. Exiting.");
  process.exit(0);
}

const existingKeys = await listAllKeys(prefix);
const toUpload = selectedFiles.filter((filePath) => {
  const relativePath = path
    .relative(hlsDir, filePath)
    .replaceAll(path.sep, "/");
  const key = prefix ? `${prefix}/${relativePath}` : relativePath;
  return !existingKeys.has(key);
});

const skipped = selectedFiles.length - toUpload.length;
if (skipped > 0) {
  console.log(`Skipping ${skipped} file(s) already in bucket.`);
}

if (!toUpload.length) {
  console.log("Nothing new to upload.");
  process.exit(0);
}

console.log(`Uploading ${toUpload.length} file(s) to ${env.bucket}...`);

await runWithConcurrency(toUpload, env.concurrency, async (filePath) => {
  const relativePath = path
    .relative(hlsDir, filePath)
    .replaceAll(path.sep, "/");
  const key = prefix ? `${prefix}/${relativePath}` : relativePath;
  const file = Bun.file(filePath);
  const { contentType, cacheControl } = resolveHeaders(filePath);

  await client.write(key, file, {
    type: contentType,
    cacheControl,
  });

  console.log(`Uploaded: ${key}`);
});

console.log("Upload complete.");

function resolveHeaders(filePath: string) {
  if (filePath.endsWith(".m3u8")) {
    return {
      contentType: "application/vnd.apple.mpegurl",
      cacheControl: "no-cache",
    };
  }
  if (filePath.endsWith(".ts")) {
    return {
      contentType: "video/MP2T",
      cacheControl: "public, max-age=31536000, immutable",
    };
  }
  if (filePath.endsWith(".vtt")) {
    return { contentType: "text/vtt", cacheControl: "public, max-age=3600" };
  }
  return {
    contentType: "application/octet-stream",
    cacheControl: "public, max-age=3600",
  };
}

async function resolvePrefix(current: string) {
  if (current) return current;
  if (!process.stdin.isTTY) return "";

  console.log("Select an upload prefix:");
  console.log("  1) (none)");
  console.log("  2) Enter custom prefix");

  const rl = readline.createInterface({ input, output });
  try {
    const answer = (await rl.question("Choice [1/2]: ")).trim();
    if (answer === "2") {
      const custom = (await rl.question("Prefix (blank for none): ")).trim();
      return custom.replace(/^\/+|\/+$/g, "");
    }
    return "";
  } finally {
    rl.close();
  }
}

async function listAllKeys(prefix: string) {
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

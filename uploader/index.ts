import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import readline from "readline/promises";
import { stdin as input, stdout as output } from "process";
import { ResultAsync } from "neverthrow";
import { loadEnv } from "./env";
import { walkFiles } from "./utils";
import { createUploadReporter, selectFiles } from "./tui.tsx";
import { uploadHlsDir } from "./upload";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const rootDir = path.resolve(__dirname, "..");
const hlsDir = path.join(rootDir, "hls");

const env = unwrapOrExit(loadEnv());

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

const files = await unwrapOrExitAsync(
  ResultAsync.fromPromise(
    walkFiles(hlsDir),
    (error) => toError("Failed to read HLS directory.", error),
  ),
);
if (!files.length) {
  console.log("No HLS files to upload.");
  process.exit(0);
}
const selectedFiles = await selectFiles(files, hlsDir);
if (!selectedFiles.length) {
  console.log("No files selected. Exiting.");
  process.exit(0);
}

console.log(`Uploading ${selectedFiles.length} file(s) to ${env.bucket}...`);

const reporter = createUploadReporter(selectedFiles.length);

try {
  await unwrapOrExitAsync(
    ResultAsync.fromPromise(
      uploadHlsDir({
        hlsDir,
        prefix,
        concurrency: env.concurrency,
        credentials,
        callbacks: {
          onStart: (name) => reporter.start(name),
          onSuccess: (name) => reporter.success(name),
          onFail: (name) => reporter.fail(name),
          onSkipped: (count) => reporter.setSkipped(count),
        },
      }),
      (error) => toError("Upload failed.", error),
    ),
  );
} finally {
  reporter.close();
}

console.log("Upload complete.");

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

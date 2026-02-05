import fs from "fs";
import path from "path";
import { spawn } from "child_process";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const projectRoot = path.join(__dirname, "..");
const videosDir = path.join(projectRoot, "videos");
const hlsDir = path.join(projectRoot, "hls");

async function main() {
  await fs.promises.mkdir(hlsDir, { recursive: true });

  const entries = await fs.promises.readdir(videosDir, { withFileTypes: true });
  const files = entries
    .filter((entry) => entry.isFile())
    .map((entry) => entry.name)
    .filter(isVideoFile)
    .sort();

  if (!files.length) {
    console.log("No videos found in videos/.");
    return;
  }

  for (const file of files) {
    const inputPath = path.join(videosDir, file);
    const hlsId = encodeHlsId(file);
    const outputDir = path.join(hlsDir, hlsId);
    const playlist = path.join(outputDir, "index.m3u8");

    await fs.promises.mkdir(outputDir, { recursive: true });

    if (await fileExists(playlist)) {
      console.log(`HLS already exists for ${file}. Skipping.`);
      continue;
    }

    console.log(`Generating HLS for ${file}...`);
    await runFFmpeg(inputPath, outputDir, playlist);
  }
}

function runFFmpeg(inputPath, outputDir, playlist) {
  return new Promise((resolve, reject) => {
    const segmentPattern = path.join(outputDir, "%03d.ts");
    const args = [
      "-i",
      inputPath,
      "-preset",
      "veryfast",
      "-g",
      "48",
      "-sc_threshold",
      "0",
      "-c:v",
      "libx264",
      "-c:a",
      "aac",
      "-b:a",
      "128k",
      "-hls_time",
      "4",
      "-hls_list_size",
      "0",
      "-hls_segment_filename",
      segmentPattern,
      playlist,
    ];

    const proc = spawn("ffmpeg", args, { stdio: "inherit" });

    proc.on("error", (err) => reject(err));
    proc.on("close", (code) => {
      if (code === 0) return resolve();
      reject(new Error(`ffmpeg exited with code ${code}`));
    });
  });
}

function encodeHlsId(name) {
  return Buffer.from(name).toString("base64url");
}

function isVideoFile(name) {
  const ext = path.extname(name).toLowerCase();
  return [".mp4", ".mov", ".webm", ".mkv", ".m4v"].includes(ext);
}

async function fileExists(filePath) {
  try {
    await fs.promises.access(filePath, fs.constants.F_OK);
    return true;
  } catch (_err) {
    return false;
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

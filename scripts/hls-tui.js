import fs from "fs";
import path from "path";
import { spawn } from "child_process";
import { fileURLToPath } from "url";
import readline from "readline/promises";
import { stdin as input, stdout as output } from "process";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const projectRoot = path.join(__dirname, "..");
const videosDir = path.join(projectRoot, "videos");
const hlsDir = path.join(projectRoot, "hls");

async function main() {
  const files = await listVideos();
  if (!files.length) {
    console.log("No videos found in videos/.");
    return;
  }

  console.log("Deleting existing HLS output...");
  await fs.promises.rm(hlsDir, { recursive: true, force: true });
  await fs.promises.mkdir(hlsDir, { recursive: true });

  const selection = await promptSelection(files);
  if (!selection.length) {
    console.log("No videos selected. Exiting.");
    return;
  }

  await runGenerator(selection);
}

async function listVideos() {
  const entries = await fs.promises.readdir(videosDir, { withFileTypes: true });
  return entries
    .filter((entry) => entry.isFile())
    .map((entry) => entry.name)
    .filter(isVideoFile)
    .sort();
}

function isVideoFile(name) {
  const ext = path.extname(name).toLowerCase();
  return [".mp4", ".mov", ".webm", ".mkv", ".m4v"].includes(ext);
}

async function promptSelection(files) {
  console.log("Select videos to generate HLS for:");
  files.forEach((file, index) => {
    const label = String(index + 1).padStart(2, " ");
    console.log(`${label}. ${file}`);
  });
  console.log("Type numbers separated by commas (e.g. 1,3,4), or 'all'.");

  const rl = readline.createInterface({ input, output });
  try {
    const answer = (await rl.question("Selection: ")).trim().toLowerCase();
    if (!answer) return [];
    if (answer === "all") return files.slice();

    const indexes = parseIndexList(answer, files.length);
    return indexes.map((idx) => files[idx]);
  } finally {
    rl.close();
  }
}

function parseIndexList(value, max) {
  const tokens = value.split(",").map((token) => token.trim()).filter(Boolean);
  const result = new Set();

  for (const token of tokens) {
    if (token.includes("-")) {
      const [startRaw, endRaw] = token.split("-").map((part) => part.trim());
      const start = Number.parseInt(startRaw, 10);
      const end = Number.parseInt(endRaw, 10);
      if (!Number.isFinite(start) || !Number.isFinite(end)) continue;
      const from = Math.min(start, end);
      const to = Math.max(start, end);
      for (let i = from; i <= to; i += 1) {
        if (i >= 1 && i <= max) result.add(i - 1);
      }
      continue;
    }

    const index = Number.parseInt(token, 10);
    if (Number.isFinite(index) && index >= 1 && index <= max) {
      result.add(index - 1);
    }
  }

  return Array.from(result).sort((a, b) => a - b);
}

function runGenerator(selection) {
  return new Promise((resolve, reject) => {
    console.log(`Generating HLS for ${selection.length} video(s)...`);
    const proc = spawn(
      "node",
      [path.join("scripts", "generate-hls.js"), ...selection],
      { stdio: "inherit" }
    );
    proc.on("error", (err) => reject(err));
    proc.on("close", (code) => {
      if (code === 0) return resolve();
      reject(new Error(`HLS generation exited with code ${code}`));
    });
  });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

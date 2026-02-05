import express from "express";
import http from "http";
import { Server } from "socket.io";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const PORT = process.env.PORT || 3000;
const VIDEOS_DIR = path.join(__dirname, "videos");
const HLS_DIR = path.join(__dirname, "hls");
const SUBTITLES_DIR = path.join(__dirname, "subtitles");
const SERVER_VERSION = Date.now().toString();

app.use("/", express.static(path.join(__dirname, "public")));
app.use("/hls", express.static(HLS_DIR));

app.get("/api/version", (_req, res) => {
  res.set("Cache-Control", "no-store, max-age=0");
  res.json({ version: SERVER_VERSION });
});

app.get("/api/videos", async (_req, res) => {
  try {
    const entries = await fs.promises.readdir(VIDEOS_DIR, { withFileTypes: true });
    const files = entries
      .filter((entry) => entry.isFile())
      .map((entry) => entry.name)
      .sort();
    const videos = files.filter(isVideoFile);
    const subtitleMap = await buildSubtitleMap();
    const payload = await Promise.all(
      videos.map(async (name) => {
        const hlsId = encodeHlsId(name);
        const playlistPath = path.join(HLS_DIR, hlsId, "index.m3u8");
        const hlsReady = await fileExists(playlistPath);
        const normalized = normalizeName(name);
        return {
          name,
          hls: hlsReady,
          hlsPath: hlsReady ? `/hls/${hlsId}/index.m3u8` : null,
          subtitles: subtitleMap.get(normalized) ?? [],
        };
      })
    );
    res.json({ files: payload });
  } catch (err) {
    res.status(500).json({ error: "Failed to read videos directory." });
  }
});

app.get("/api/subtitles/:name", async (req, res) => {
  const safeName = path.basename(req.params.name);
  const subtitlesPath = path.join(SUBTITLES_DIR, safeName);
  const videosPath = path.join(VIDEOS_DIR, safeName);

  if (!subtitlesPath.startsWith(SUBTITLES_DIR) || !videosPath.startsWith(VIDEOS_DIR)) {
    res.sendStatus(400);
    return;
  }

  const filePath = (await fileExists(subtitlesPath)) ? subtitlesPath : videosPath;
  if (!(await fileExists(filePath))) {
    res.sendStatus(404);
    return;
  }

  const ext = path.extname(filePath).toLowerCase();
  try {
    if (ext === ".vtt") {
      res.type("text/vtt");
      fs.createReadStream(filePath).pipe(res);
      return;
    }
    if (ext === ".srt") {
      const raw = await fs.promises.readFile(filePath, "utf8");
      res.type("text/vtt");
      res.send(convertSrtToVtt(raw));
      return;
    }
    res.sendStatus(415);
  } catch (_err) {
    res.sendStatus(500);
  }
});
app.get("/videos/:name", async (req, res) => {
  const safeName = path.basename(req.params.name);
  const filePath = path.join(VIDEOS_DIR, safeName);

  if (!filePath.startsWith(VIDEOS_DIR)) {
    res.sendStatus(400);
    return;
  }

  let stat;
  try {
    stat = await fs.promises.stat(filePath);
  } catch (_err) {
    res.sendStatus(404);
    return;
  }

  const range = req.headers.range;
  const fileSize = stat.size;
  const contentType = getContentType(filePath);

  if (range) {
    const [startStr, endStr] = range.replace(/bytes=/, "").split("-");
    const start = Number.parseInt(startStr, 10);
    const end = endStr ? Number.parseInt(endStr, 10) : fileSize - 1;

    if (Number.isNaN(start) || Number.isNaN(end) || start > end || end >= fileSize) {
      res.status(416).set({ "Content-Range": `bytes */${fileSize}` }).end();
      return;
    }

    res.writeHead(206, {
      "Content-Range": `bytes ${start}-${end}/${fileSize}`,
      "Accept-Ranges": "bytes",
      "Content-Length": end - start + 1,
      "Content-Type": contentType,
    });

    fs.createReadStream(filePath, { start, end }).pipe(res);
    return;
  }

  res.writeHead(200, {
    "Content-Length": fileSize,
    "Content-Type": contentType,
    "Accept-Ranges": "bytes",
  });

  fs.createReadStream(filePath).pipe(res);
});

io.on("connection", (socket) => {
  socket.emit("server-version", { version: SERVER_VERSION });
  io.emit("room-info", { count: io.engine.clientsCount });
  socket.broadcast.emit("request-state", { requester: socket.id });

  socket.on("state", ({ state }) => {
    if (!state) return;
    socket.broadcast.emit("state", { state, at: Date.now() });
  });

  socket.on("request-state", ({ requester }) => {
    if (!requester) return;
    socket.broadcast.emit("request-state", { requester });
  });

  socket.on("reply-state", ({ to, state }) => {
    if (!to || !state) return;
    io.to(to).emit("state", { state, at: Date.now() });
  });

  socket.on("chat", (message) => {
    if (!message || !message.text) return;
    socket.broadcast.emit("chat", message);
  });

  socket.on("disconnect", () => {
    io.emit("room-info", { count: io.engine.clientsCount });
  });
});

server.listen(PORT, () => {
  console.log(`Sync player running on http://localhost:${PORT}`);
});

function getContentType(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === ".mp4") return "video/mp4";
  if (ext === ".mov") return "video/quicktime";
  if (ext === ".webm") return "video/webm";
  if (ext === ".mkv") return "video/x-matroska";
  return "application/octet-stream";
}

function isVideoFile(name) {
  const ext = path.extname(name).toLowerCase();
  return [".mp4", ".mov", ".webm", ".mkv", ".m4v"].includes(ext);
}

function isSubtitleFile(name) {
  const ext = path.extname(name).toLowerCase();
  return [".vtt", ".srt"].includes(ext);
}

function normalizeName(name) {
  const base = path.basename(name, path.extname(name));
  const cleaned = base.toLowerCase();
  const normalized = cleaned
    .replace(/s(\d{1,2})\s*e(\d{1,2})/g, (_m, s, e) => `s${Number(s)}e${Number(e)}`)
    .replace(/(\d{1,2})x(\d{1,2})/g, (_m, s, e) => `s${Number(s)}e${Number(e)}`)
    .replace(/[^a-z0-9]+/g, " ")
    .replace(
      /\b(480p|720p|1080p|2160p|4k|hdr|dvdrip|hdtv|webrip|webdl|bluray|bdrip|x264|x265|h264|h265|aac|dts|subs|sub|eng|en)\b/g,
      " "
    )
    .replace(/\s+/g, " ")
    .trim();
  return normalized;
}

async function buildSubtitleMap() {
  const map = new Map();
  const subtitleFiles = [];

  const local = await safeReadDir(VIDEOS_DIR);
  subtitleFiles.push(...local.filter(isSubtitleFile));

  const external = await safeReadDir(SUBTITLES_DIR);
  subtitleFiles.push(...external.filter(isSubtitleFile));

  for (const file of subtitleFiles) {
    const key = normalizeName(file);
    const list = map.get(key) ?? [];
    if (!list.includes(file)) list.push(file);
    map.set(key, sortSubtitles(list));
  }
  return map;
}

function encodeHlsId(name) {
  return Buffer.from(name).toString("base64url");
}

async function fileExists(filePath) {
  try {
    await fs.promises.access(filePath, fs.constants.F_OK);
    return true;
  } catch (_err) {
    return false;
  }
}

async function safeReadDir(dirPath) {
  try {
    const entries = await fs.promises.readdir(dirPath, { withFileTypes: true });
    return entries.filter((entry) => entry.isFile()).map((entry) => entry.name);
  } catch (_err) {
    return [];
  }
}

function convertSrtToVtt(srt) {
  const content = srt.replace(/\r/g, "").trim();
  const lines = content.split("\n");
  const converted = lines.map((line) => line.replace(/(\d{2}:\d{2}:\d{2}),(\d{3})/g, "$1.$2"));
  return `WEBVTT\n\n${converted.join("\n")}\n`;
}

function sortSubtitles(list) {
  const priorities = ["hdtv", "lol", "webdl", "webrip", "bluray", "bdrip", "dvdrip"];
  return list.slice().sort((a, b) => scoreSubtitle(b, priorities) - scoreSubtitle(a, priorities));
}

function scoreSubtitle(name, priorities) {
  const lowered = name.toLowerCase();
  let score = 0;
  priorities.forEach((token, index) => {
    if (lowered.includes(token)) score += 10 - index;
  });
  return score;
}

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

app.use("/", express.static(path.join(__dirname, "public")));
app.use("/hls", express.static(HLS_DIR));

app.get("/api/videos", async (_req, res) => {
  try {
    const entries = await fs.promises.readdir(VIDEOS_DIR, { withFileTypes: true });
    const files = entries
      .filter((entry) => entry.isFile())
      .map((entry) => entry.name)
      .filter(isVideoFile)
      .sort();
    const payload = await Promise.all(
      files.map(async (name) => {
        const hlsId = encodeHlsId(name);
        const playlistPath = path.join(HLS_DIR, hlsId, "index.m3u8");
        const hlsReady = await fileExists(playlistPath);
        return {
          name,
          hls: hlsReady,
          hlsPath: hlsReady ? `/hls/${hlsId}/index.m3u8` : null,
        };
      })
    );
    res.json({ files: payload });
  } catch (err) {
    res.status(500).json({ error: "Failed to read videos directory." });
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

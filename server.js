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

const corsOriginEnv = process.env.CORS_ORIGIN;
const corsOrigins = corsOriginEnv
  ? corsOriginEnv.split(",").map((origin) => origin.trim()).filter(Boolean)
  : "*";

const io = new Server(server, {
  cors: {
    origin: corsOrigins,
    methods: ["GET", "POST"],
  },
});

const PORT = process.env.PORT || 3000;
const VIDEOS_DIR = path.join(__dirname, "videos");
const HLS_DIR = path.join(__dirname, "hls");
const SERVER_VERSION = Date.now().toString();

app.use((req, res, next) => {
  const origin = req.headers.origin;
  if (corsOrigins === "*") {
    res.setHeader("Access-Control-Allow-Origin", "*");
  } else if (origin && corsOrigins.includes(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
  }
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") {
    res.sendStatus(204);
    return;
  }
  next();
});

app.use(
  "/hls",
  express.static(HLS_DIR, {
    setHeaders(res, filePath) {
      if (filePath.endsWith(".m3u8")) {
        res.setHeader("Cache-Control", "no-cache");
        return;
      }
      if (filePath.endsWith(".vtt")) {
        res.setHeader("Cache-Control", "public, max-age=3600");
        return;
      }
      if (filePath.endsWith(".ts")) {
        res.setHeader("Cache-Control", "public, max-age=31536000, immutable");
      }
    },
  })
);

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

    const payload = await Promise.all(
      videos.map(async (name) => {
        const hlsId = encodeHlsId(name);
        const playlistPath = path.join(HLS_DIR, hlsId, "index.m3u8");
        const subtitlePlaylistPath = path.join(HLS_DIR, hlsId, "index_vtt.m3u8");
        const hlsReady = await fileExists(playlistPath);
        const hlsSubtitles = await fileExists(subtitlePlaylistPath);
        return {
          name,
          hls: hlsReady,
          hlsPath: hlsReady ? `/hls/${hlsId}/index.m3u8` : null,
          hlsMasterPath: hlsReady
            ? hlsSubtitles
              ? `/api/hls/${hlsId}/master.m3u8`
              : `/hls/${hlsId}/index.m3u8`
            : null,
          hlsSubtitles,
        };
      })
    );

    res.json({ files: payload });
  } catch (_err) {
    res.status(500).json({ error: "Failed to read videos directory." });
  }
});

app.get("/api/hls/:id/master.m3u8", async (req, res) => {
  const safeId = path.basename(req.params.id);
  const baseDir = path.join(HLS_DIR, safeId);
  const baseUrl = `/hls/${safeId}`;

  if (!baseDir.startsWith(HLS_DIR)) {
    res.sendStatus(400);
    return;
  }

  const videoPlaylist = path.join(baseDir, "index.m3u8");
  const subtitlePlaylist = path.join(baseDir, "index_vtt.m3u8");

  if (!(await fileExists(videoPlaylist))) {
    res.sendStatus(404);
    return;
  }

  const hasSubtitles = await fileExists(subtitlePlaylist);
  const master = [
    "#EXTM3U",
    "#EXT-X-VERSION:3",
    ...(hasSubtitles
      ? [
          `#EXT-X-MEDIA:TYPE=SUBTITLES,GROUP-ID=\"subs\",NAME=\"English\",DEFAULT=YES,AUTOSELECT=YES,LANGUAGE=\"en\",URI=\"${baseUrl}/index_vtt.m3u8\"`,
        ]
      : []),
    `#EXT-X-STREAM-INF:BANDWIDTH=1200000${hasSubtitles ? ',SUBTITLES=\"subs\"' : ""}`,
    `${baseUrl}/index.m3u8`,
    "",
  ].join("\n");

  res.type("application/vnd.apple.mpegurl");
  res.send(master);
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

  socket.on("chat-reaction", (payload) => {
    if (!payload || !payload.id || !payload.emoji || !payload.sender || !payload.action) return;
    socket.broadcast.emit("chat-reaction", payload);
  });

  socket.on("call-offer", ({ offer }) => {
    if (!offer) return;
    socket.broadcast.emit("call-offer", { offer });
  });

  socket.on("call-answer", ({ answer }) => {
    if (!answer) return;
    socket.broadcast.emit("call-answer", { answer });
  });

  socket.on("call-ice", ({ candidate }) => {
    if (!candidate) return;
    socket.broadcast.emit("call-ice", { candidate });
  });

  socket.on("call-end", () => {
    socket.broadcast.emit("call-end");
  });

  socket.on("player-reaction", (payload, ack) => {
    if (!payload || !payload.emoji) return;
    io.emit("player-reaction", payload);
    if (typeof ack === "function") {
      ack({ ok: true });
    }
  });

  socket.on("disconnect", () => {
    io.emit("room-info", { count: io.engine.clientsCount });
  });
});

server.listen(PORT, () => {
  console.log(`Sync player running on http://localhost:${PORT}`);
});

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
  } catch {
    return false;
  }
}

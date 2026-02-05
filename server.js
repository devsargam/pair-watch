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

app.use("/", express.static(path.join(__dirname, "public")));

app.get("/api/videos", async (_req, res) => {
  try {
    const entries = await fs.promises.readdir(VIDEOS_DIR, { withFileTypes: true });
    const files = entries
      .filter((entry) => entry.isFile())
      .map((entry) => entry.name)
      .sort();
    res.json({ files });
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
  socket.on("join", ({ room }) => {
    if (!room) return;
    socket.join(room);

    const clients = io.sockets.adapter.rooms.get(room);
    const count = clients ? clients.size : 0;

    io.to(room).emit("room-info", { count });
    socket.to(room).emit("request-state", { requester: socket.id });
  });

  socket.on("state", ({ room, state }) => {
    if (!room || !state) return;
    socket.to(room).emit("state", { state, at: Date.now() });
  });

  socket.on("request-state", ({ room, requester }) => {
    if (!room || !requester) return;
    socket.to(room).emit("request-state", { requester });
  });

  socket.on("reply-state", ({ to, state }) => {
    if (!to || !state) return;
    io.to(to).emit("state", { state, at: Date.now() });
  });

  socket.on("disconnecting", () => {
    for (const room of socket.rooms) {
      if (room === socket.id) continue;
      const clients = io.sockets.adapter.rooms.get(room);
      const count = clients ? clients.size - 1 : 0;
      io.to(room).emit("room-info", { count });
    }
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

import express from "express";
import http from "http";
import next from "next";
import { Server } from "socket.io";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const dev = process.env.NODE_ENV !== "production";
const nextApp = next({ dev });
const handle = nextApp.getRequestHandler();

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const PORT = process.env.PORT || 3000;
const HLS_DIR = path.join(__dirname, "hls");
process.env.SERVER_VERSION ||= Date.now().toString();

app.use("/hls", express.static(HLS_DIR));

io.on("connection", (socket) => {
  socket.emit("server-version", { version: process.env.SERVER_VERSION });
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

  socket.on("disconnect", () => {
    io.emit("room-info", { count: io.engine.clientsCount });
  });
});

await nextApp.prepare();

app.all("*", (req, res) => handle(req, res));

server.listen(PORT, () => {
  console.log(`Sync player running on http://localhost:${PORT}`);
});

const socket = io();

const roomInput = document.getElementById("room");
const videoSelect = document.getElementById("video-select");
const playAllToggle = document.getElementById("play-all");
const joinButton = document.getElementById("join");
const resyncButton = document.getElementById("resync");
const player = document.getElementById("player");
const statusEl = document.getElementById("status");
const statusDot = document.getElementById("status-dot");
const peersEl = document.getElementById("peers");
const syncStateEl = document.getElementById("sync-state");

let currentRoom = "";
let isApplyingRemote = false;
let pendingRemoteState = null;
let lastLocalUpdate = 0;
let playlist = [];

const SYNC_THRESHOLD = 0.35; // seconds
const HEARTBEAT_MS = 3000;

init();

async function init() {
  roomInput.value = randomRoom();
  await loadVideos();
  setStatus("Disconnected", false);

  joinButton.addEventListener("click", () => {
    const room = roomInput.value.trim();
    if (!room) return;
    currentRoom = room;
    socket.emit("join", { room });
    setStatus(`Connected to ${room}`, true);
    syncStateEl.textContent = "Waiting";
    pushState("join");
  });

  resyncButton.addEventListener("click", () => {
    if (!currentRoom) return;
    socket.emit("request-state", { room: currentRoom, requester: socket.id });
    syncStateEl.textContent = "Requesting state";
  });

  videoSelect.addEventListener("change", () => {
    const filename = videoSelect.value;
    setVideo(filename);
    pushState("video-change");
  });

  playAllToggle.addEventListener("change", () => {
    pushState("play-all");
  });

  ["play", "pause", "seeked", "ratechange"].forEach((eventName) => {
    player.addEventListener(eventName, () => pushState(eventName));
  });

  player.addEventListener("ended", () => {
    if (!playAllToggle.checked) return;
    const next = getNextVideo();
    if (!next) return;
    videoSelect.value = next;
    setVideo(next);
    player.play().catch(() => {});
    pushState("auto-next");
  });

  player.addEventListener("loadedmetadata", () => {
    if (pendingRemoteState) {
      applyRemoteState(pendingRemoteState);
      pendingRemoteState = null;
    }
  });

  socket.on("room-info", ({ count }) => {
    peersEl.textContent = count;
  });

  socket.on("request-state", ({ requester }) => {
    if (!currentRoom) return;
    socket.emit("reply-state", { to: requester, state: collectState() });
  });

  socket.on("state", ({ state }) => {
    if (!state) return;
    if (Date.now() - lastLocalUpdate < 150) return;
    applyRemoteState(state);
  });

  setInterval(() => {
    if (!currentRoom || player.paused) return;
    pushState("heartbeat");
  }, HEARTBEAT_MS);
}

async function loadVideos() {
  const response = await fetch("/api/videos");
  const { files } = await response.json();
  videoSelect.innerHTML = "";

  if (!files || files.length === 0) {
    const option = document.createElement("option");
    option.textContent = "No videos found";
    option.value = "";
    videoSelect.appendChild(option);
    return;
  }

  playlist = files.slice();

  files.forEach((file) => {
    const option = document.createElement("option");
    option.value = file;
    option.textContent = file;
    videoSelect.appendChild(option);
  });

  setVideo(files[0]);
}

function setVideo(filename) {
  if (!filename) return;
  player.src = `/videos/${encodeURIComponent(filename)}`;
  player.load();
}

function pushState(reason) {
  if (!currentRoom || isApplyingRemote) return;
  lastLocalUpdate = Date.now();
  const state = collectState();
  state.reason = reason;
  socket.emit("state", { room: currentRoom, state });
}

function collectState() {
  return {
    video: videoSelect.value,
    paused: player.paused,
    time: player.currentTime || 0,
    playbackRate: player.playbackRate || 1,
    playAll: playAllToggle.checked,
  };
}

function applyRemoteState(state) {
  if (!state) return;
  isApplyingRemote = true;
  syncStateEl.textContent = state.reason ? `Syncing (${state.reason})` : "Syncing";

  const needsVideoChange = state.video && state.video !== videoSelect.value;
  if (needsVideoChange) {
    videoSelect.value = state.video;
    setVideo(state.video);
    pendingRemoteState = state;
    isApplyingRemote = false;
    return;
  }

  if (typeof state.playAll === "boolean") {
    playAllToggle.checked = state.playAll;
  }

  if (Math.abs(player.currentTime - state.time) > SYNC_THRESHOLD) {
    player.currentTime = state.time;
  }

  if (player.playbackRate !== state.playbackRate) {
    player.playbackRate = state.playbackRate;
  }

  if (state.paused) {
    player.pause();
  } else {
    player.play().catch(() => {});
  }

  setTimeout(() => {
    isApplyingRemote = false;
    syncStateEl.textContent = "In sync";
  }, 100);
}

function setStatus(text, isConnected) {
  statusEl.textContent = text;
  statusDot.classList.toggle("online", isConnected);
}

function randomRoom() {
  return Math.random().toString(36).slice(2, 8);
}

function getNextVideo() {
  if (!playlist.length) return null;
  const currentIndex = playlist.indexOf(videoSelect.value);
  if (currentIndex === -1) return playlist[0];
  return playlist[(currentIndex + 1) % playlist.length];
}

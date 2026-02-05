const socket = io();

const videoSelect = document.getElementById("video-select");
const playAllToggle = document.getElementById("play-all");
const resyncButton = document.getElementById("resync");
const player = document.getElementById("player");
const statusEl = document.getElementById("status");
const statusDot = document.getElementById("status-dot");
const peersEl = document.getElementById("peers");
const syncStateEl = document.getElementById("sync-state");
const hlsNote = document.getElementById("hls-note");
const chatMessages = document.getElementById("chat-messages");
const chatForm = document.getElementById("chat-form");
const chatInput = document.getElementById("chat-input");
const callStart = document.getElementById("call-start");
const callEnd = document.getElementById("call-end");
const localCall = document.getElementById("local-call");
const remoteCall = document.getElementById("remote-call");

let isApplyingRemote = false;
let pendingRemoteState = null;
let lastLocalUpdate = 0;
let playlist = [];
let videoCatalog = [];
let hlsPlayer = null;
let serverVersion = null;
let localStream = null;
let peerConnection = null;

const SYNC_THRESHOLD = 0.35; // seconds
const HEARTBEAT_MS = 3000;
const VERSION_POLL_MS = 5000;
const STATE_CACHE_KEY = "pairwatch:lastState";

init();

async function init() {
  await loadVideos();
  setStatus("Connected", true);
  syncStateEl.textContent = "Waiting";
  pushState("join");
  await checkVersion();
  restoreCachedState();

  resyncButton.addEventListener("click", () => {
    socket.emit("request-state", { requester: socket.id });
    syncStateEl.textContent = "Requesting state";
  });

  chatForm.addEventListener("submit", (event) => {
    event.preventDefault();
    const text = chatInput.value.trim();
    if (!text) return;
    const message = {
      text,
      sender: socket.id,
      at: Date.now(),
    };
    appendChatMessage(message, true);
    socket.emit("chat", message);
    chatInput.value = "";
  });

  callStart.addEventListener("click", async () => {
    await startCall();
  });

  callEnd.addEventListener("click", () => {
    endCall();
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
    showFirstTextTrack();
  });

  socket.on("room-info", ({ count }) => {
    peersEl.textContent = count;
  });

  socket.on("request-state", ({ requester }) => {
    socket.emit("reply-state", { to: requester, state: collectState() });
  });

  socket.on("state", ({ state }) => {
    if (!state) return;
    if (Date.now() - lastLocalUpdate < 150) return;
    applyRemoteState(state);
  });

  socket.on("server-version", ({ version }) => {
    if (!version) return;
    if (!serverVersion) {
      serverVersion = version;
      return;
    }
    if (version !== serverVersion) {
      cacheState(collectState());
      location.reload();
    }
  });

  socket.on("chat", (message) => {
    if (!message) return;
    appendChatMessage(message, false);
  });

  socket.on("call-offer", async ({ offer }) => {
    if (!offer) return;
    await ensurePeerConnection();
    await peerConnection.setRemoteDescription(offer);
    const answer = await peerConnection.createAnswer();
    await peerConnection.setLocalDescription(answer);
    socket.emit("call-answer", { answer });
  });

  socket.on("call-answer", async ({ answer }) => {
    if (!answer || !peerConnection) return;
    await peerConnection.setRemoteDescription(answer);
  });

  socket.on("call-ice", async ({ candidate }) => {
    if (!candidate || !peerConnection) return;
    try {
      await peerConnection.addIceCandidate(candidate);
    } catch (_err) {
      // ignore ICE errors
    }
  });

  socket.on("call-end", () => {
    endCall();
  });

  setInterval(() => {
    if (player.paused) return;
    pushState("heartbeat");
  }, HEARTBEAT_MS);

  setInterval(async () => {
    await checkVersion(true);
  }, VERSION_POLL_MS);
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

  videoCatalog = files.slice();
  videoCatalog = videoCatalog.filter((entry) => isVideoFile(entry.name) && entry.hls);
  playlist = videoCatalog.map((entry) => entry.name);

  if (!videoCatalog.length) {
    const option = document.createElement("option");
    option.textContent = "No HLS-ready videos. Run `npm run hls`.";
    option.value = "";
    videoSelect.appendChild(option);
    hlsNote.textContent = "No HLS-ready videos yet. Run `npm run hls` and reload.";
    return;
  }

  videoCatalog.forEach((entry) => {
    const option = document.createElement("option");
    option.value = entry.name;
    option.textContent = entry.name;
    videoSelect.appendChild(option);
  });

  setVideo(videoCatalog[0].name);
}

function setVideo(filename) {
  if (!filename) return;
  const entry = videoCatalog.find((item) => item.name === filename);
  const hlsPath = entry && entry.hls ? entry.hlsPath : null;
  const subtitles = entry?.subtitles ?? [];

  if (hlsPlayer) {
    hlsPlayer.destroy();
    hlsPlayer = null;
  }

  if (!hlsPath) {
    player.removeAttribute("src");
    player.load();
    hlsNote.textContent = "HLS not found for this file. Run `npm run hls` and reload.";
    return;
  }

  hlsNote.textContent = "";

  clearTracks();
  addSubtitleTracks(subtitles);

  if (window.Hls && window.Hls.isSupported()) {
    hlsPlayer = new window.Hls();
    hlsPlayer.loadSource(hlsPath);
    hlsPlayer.attachMedia(player);
  } else if (player.canPlayType("application/vnd.apple.mpegurl")) {
    player.src = hlsPath;
  }

  player.load();
}

function pushState(reason) {
  if (isApplyingRemote) return;
  lastLocalUpdate = Date.now();
  const state = collectState();
  state.reason = reason;
  socket.emit("state", { state });
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

  cacheState(state);

  setTimeout(() => {
    isApplyingRemote = false;
    syncStateEl.textContent = "In sync";
  }, 100);
}

function setStatus(text, isConnected) {
  statusEl.textContent = text;
  statusDot.classList.toggle("online", isConnected);
}

function getNextVideo() {
  if (!playlist.length) return null;
  const currentIndex = playlist.indexOf(videoSelect.value);
  if (currentIndex === -1) return playlist[0];
  return playlist[(currentIndex + 1) % playlist.length];
}

function isVideoFile(name) {
  const ext = name.split(".").pop()?.toLowerCase();
  return ["mp4", "mov", "webm", "mkv", "m4v"].includes(ext);
}

function appendChatMessage(message, isMine) {
  const wrapper = document.createElement("div");
  wrapper.className = `chat-message${isMine ? " mine" : ""}`;

  const meta = document.createElement("div");
  meta.className = "meta";
  const who = document.createElement("span");
  who.textContent = isMine ? "You" : "Peer";
  const time = document.createElement("span");
  time.textContent = new Date(message.at).toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
  });
  meta.append(who, time);

  const bubble = document.createElement("div");
  bubble.className = "bubble";
  bubble.textContent = message.text;

  wrapper.append(meta, bubble);
  chatMessages.appendChild(wrapper);
  chatMessages.scrollTop = chatMessages.scrollHeight;
}

function clearTracks() {
  const tracks = Array.from(player.querySelectorAll("track"));
  tracks.forEach((track) => track.remove());
}

function addSubtitleTracks(subtitles) {
  if (!subtitles.length) return;
  subtitles.forEach((file, index) => {
    const track = document.createElement("track");
    track.kind = "subtitles";
    track.label = subtitleLabel(file, index);
    track.srclang = "en";
    track.src = `/api/subtitles/${encodeURIComponent(file)}`;
    track.default = index === 0;
    player.appendChild(track);
  });
  showFirstTextTrack();
}

function subtitleLabel(file, index) {
  const name = file.replace(/\.[^.]+$/, "");
  return name || `Sub ${index + 1}`;
}

function showFirstTextTrack() {
  if (!player.textTracks || player.textTracks.length === 0) return;
  Array.from(player.textTracks).forEach((track, idx) => {
    track.mode = idx === 0 ? "showing" : "hidden";
  });
}

async function startCall() {
  await ensurePeerConnection();
  const offer = await peerConnection.createOffer();
  await peerConnection.setLocalDescription(offer);
  socket.emit("call-offer", { offer });
}

async function ensurePeerConnection() {
  if (!localStream) {
    localStream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
    localCall.srcObject = localStream;
  }

  if (!peerConnection) {
    peerConnection = new RTCPeerConnection({
      iceServers: [{ urls: "stun:stun.l.google.com:19302" }],
    });

    localStream.getTracks().forEach((track) => {
      peerConnection.addTrack(track, localStream);
    });

    peerConnection.ontrack = (event) => {
      if (remoteCall.srcObject !== event.streams[0]) {
        remoteCall.srcObject = event.streams[0];
      }
    };

    peerConnection.onicecandidate = (event) => {
      if (event.candidate) {
        socket.emit("call-ice", { candidate: event.candidate });
      }
    };
  }
}

function endCall() {
  if (peerConnection) {
    peerConnection.ontrack = null;
    peerConnection.onicecandidate = null;
    peerConnection.close();
    peerConnection = null;
  }
  if (remoteCall.srcObject) {
    remoteCall.srcObject = null;
  }
  if (localStream) {
    localStream.getTracks().forEach((track) => track.stop());
    localStream = null;
    localCall.srcObject = null;
  }
  socket.emit("call-end");
}

window.addEventListener("beforeunload", () => {
  if (peerConnection || localStream) {
    socket.emit("call-end");
  }
});

function cacheState(state) {
  if (!state || !state.video) return;
  const payload = {
    video: state.video,
    time: state.time || 0,
    paused: state.paused ?? true,
    playbackRate: state.playbackRate || 1,
    playAll: state.playAll ?? false,
    at: Date.now(),
  };
  localStorage.setItem(STATE_CACHE_KEY, JSON.stringify(payload));
}

function restoreCachedState() {
  const raw = localStorage.getItem(STATE_CACHE_KEY);
  if (!raw) return;
  let cached;
  try {
    cached = JSON.parse(raw);
  } catch (_err) {
    return;
  }
  if (!cached || !cached.video) return;
  if (videoCatalog.length && !videoCatalog.find((entry) => entry.name === cached.video)) {
    return;
  }
  videoSelect.value = cached.video;
  setVideo(cached.video);
  const desired = {
    video: cached.video,
    paused: cached.paused,
    time: cached.time,
    playbackRate: cached.playbackRate,
    playAll: cached.playAll,
  };
  applyRemoteState(desired);
}

async function checkVersion(shouldReload = false) {
  try {
    const response = await fetch(`/api/version?t=${Date.now()}`, { cache: "no-store" });
    const data = await response.json();
    if (!serverVersion) {
      serverVersion = data.version;
      return;
    }
    if (data.version && data.version !== serverVersion && shouldReload) {
      cacheState(collectState());
      location.reload();
    }
  } catch (_err) {
    // ignore polling errors
  }
}

window.addEventListener("beforeunload", () => {
  cacheState(collectState());
  if (peerConnection || localStream) {
    socket.emit("call-end");
  }
});

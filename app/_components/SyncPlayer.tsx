"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { io, type Socket } from "socket.io-client";
import Hls from "hls.js";

const SYNC_THRESHOLD = 0.35;
const HEARTBEAT_MS = 3000;
const VERSION_POLL_MS = 5000;
const STATE_CACHE_KEY = "pairwatch:lastState";

type VideoEntry = {
  name: string;
  hls: boolean;
  hlsPath: string | null;
  hlsMasterPath: string | null;
  hlsSubtitles: boolean;
};

type PlaybackState = {
  video: string;
  paused: boolean;
  time: number;
  playbackRate: number;
  playAll: boolean;
  reason?: string;
};

type ChatMessage = {
  text: string;
  sender: string;
  at: number;
};

export default function SyncPlayer() {
  const playerRef = useRef<HTMLVideoElement | null>(null);
  const localCallRef = useRef<HTMLVideoElement | null>(null);
  const remoteCallRef = useRef<HTMLVideoElement | null>(null);
  const socketRef = useRef<Socket | null>(null);
  const hlsRef = useRef<Hls | null>(null);
  const isApplyingRemoteRef = useRef(false);
  const pendingRemoteRef = useRef<PlaybackState | null>(null);
  const lastLocalUpdateRef = useRef(0);
  const playlistRef = useRef<string[]>([]);
  const serverVersionRef = useRef<string | null>(null);
  const localStreamRef = useRef<MediaStream | null>(null);
  const peerConnectionRef = useRef<RTCPeerConnection | null>(null);

  const [videos, setVideos] = useState<VideoEntry[]>([]);
  const [selectedVideo, setSelectedVideo] = useState("");
  const [playAll, setPlayAll] = useState(false);
  const [peers, setPeers] = useState(0);
  const [syncState, setSyncState] = useState("Idle");
  const [status, setStatus] = useState("Connecting");
  const [hlsNote, setHlsNote] = useState("");
  const [messages, setMessages] = useState<ChatMessage[]>([]);

  const selectedEntry = useMemo(
    () => videos.find((video) => video.name === selectedVideo) ?? null,
    [videos, selectedVideo]
  );

  useEffect(() => {
    loadVideos();
    const socket = io();
    socketRef.current = socket;

    socket.on("connect", () => {
      setStatus("Connected");
      socket.emit("request-state", { requester: socket.id });
    });

    socket.on("room-info", ({ count }) => {
      setPeers(count ?? 0);
    });

    socket.on("request-state", ({ requester }) => {
      if (!requester) return;
      socket.emit("reply-state", { to: requester, state: collectState() });
    });

    socket.on("state", ({ state }) => {
      if (!state) return;
      if (Date.now() - lastLocalUpdateRef.current < 150) return;
      applyRemoteState(state);
    });

    socket.on("server-version", ({ version }) => {
      if (!version) return;
      if (!serverVersionRef.current) {
        serverVersionRef.current = version;
        return;
      }
      if (version !== serverVersionRef.current) {
        cacheState(collectState());
        location.reload();
      }
    });

    socket.on("chat", (message: ChatMessage) => {
      if (!message) return;
      setMessages((prev) => [...prev, message]);
    });

    socket.on("call-offer", async ({ offer }) => {
      if (!offer) return;
      await ensurePeerConnection();
      await peerConnectionRef.current?.setRemoteDescription(offer);
      const answer = await peerConnectionRef.current?.createAnswer();
      if (!answer) return;
      await peerConnectionRef.current?.setLocalDescription(answer);
      socket.emit("call-answer", { answer });
    });

    socket.on("call-answer", async ({ answer }) => {
      if (!answer) return;
      await peerConnectionRef.current?.setRemoteDescription(answer);
    });

    socket.on("call-ice", async ({ candidate }) => {
      if (!candidate) return;
      try {
        await peerConnectionRef.current?.addIceCandidate(candidate);
      } catch {
        // ignore ICE errors
      }
    });

    socket.on("call-end", () => {
      endCall();
    });

    const heartbeat = window.setInterval(() => {
      const video = playerRef.current;
      if (!video || video.paused) return;
      pushState("heartbeat");
    }, HEARTBEAT_MS);

    const versionPoll = window.setInterval(() => {
      checkVersion(true).catch(() => {});
    }, VERSION_POLL_MS);

    window.addEventListener("beforeunload", handleBeforeUnload);

    return () => {
      window.clearInterval(heartbeat);
      window.clearInterval(versionPoll);
      window.removeEventListener("beforeunload", handleBeforeUnload);
      socket.disconnect();
    };
  }, []);

  useEffect(() => {
    const video = playerRef.current;
    if (!video) return;

    const handlePlay = () => pushState("play");
    const handlePause = () => pushState("pause");
    const handleSeeked = () => pushState("seeked");
    const handleRateChange = () => pushState("ratechange");
    const handleLoaded = () => {
      if (pendingRemoteRef.current) {
        applyRemoteState(pendingRemoteRef.current);
        pendingRemoteRef.current = null;
      }
      showFirstTextTrack();
    };
    const handleEnded = () => {
      if (!playAll) return;
      const next = getNextVideo();
      if (!next) return;
      setSelectedVideo(next);
      pushState("auto-next");
    };

    video.addEventListener("play", handlePlay);
    video.addEventListener("pause", handlePause);
    video.addEventListener("seeked", handleSeeked);
    video.addEventListener("ratechange", handleRateChange);
    video.addEventListener("loadedmetadata", handleLoaded);
    video.addEventListener("ended", handleEnded);

    return () => {
      video.removeEventListener("play", handlePlay);
      video.removeEventListener("pause", handlePause);
      video.removeEventListener("seeked", handleSeeked);
      video.removeEventListener("ratechange", handleRateChange);
      video.removeEventListener("loadedmetadata", handleLoaded);
      video.removeEventListener("ended", handleEnded);
    };
  }, [playAll]);

  useEffect(() => {
    const video = playerRef.current;
    if (!video || !selectedEntry?.hlsMasterPath) return;

    if (hlsRef.current) {
      hlsRef.current.destroy();
      hlsRef.current = null;
    }

    const source = selectedEntry.hlsMasterPath;

    if (Hls.isSupported()) {
      const hls = new Hls();
      hlsRef.current = hls;
      hls.on(Hls.Events.MANIFEST_PARSED, () => enableHlsSubtitles(hls));
      hls.on(Hls.Events.SUBTITLE_TRACKS_UPDATED, () => enableHlsSubtitles(hls));
      hls.loadSource(source);
      hls.attachMedia(video);
    } else {
      video.src = source;
    }

    video.load();

    return () => {
      if (hlsRef.current) {
        hlsRef.current.destroy();
        hlsRef.current = null;
      }
    };
  }, [selectedEntry]);

  async function loadVideos() {
    try {
      const response = await fetch("/api/videos", { cache: "no-store" });
      const data = await response.json();
      const list: VideoEntry[] = (data.files ?? []).filter((video: VideoEntry) => video.hls);
      if (!list.length) {
        setHlsNote("No HLS-ready videos. Run `pnpm hls` and reload.");
        return;
      }
      setVideos(list);
      playlistRef.current = list.map((entry) => entry.name);
      setSelectedVideo((prev) => prev || list[0].name);
      restoreCachedState(list);
    } catch {
      setHlsNote("Failed to load video list.");
    }
  }

  function pushState(reason: string) {
    if (isApplyingRemoteRef.current) return;
    lastLocalUpdateRef.current = Date.now();
    const state = collectState();
    state.reason = reason;
    socketRef.current?.emit("state", { state });
  }

  function collectState(): PlaybackState {
    const video = playerRef.current;
    return {
      video: selectedVideo,
      paused: video?.paused ?? true,
      time: video?.currentTime ?? 0,
      playbackRate: video?.playbackRate ?? 1,
      playAll,
    };
  }

  function applyRemoteState(state: PlaybackState) {
    const video = playerRef.current;
    if (!video) return;

    isApplyingRemoteRef.current = true;
    setSyncState(state.reason ? `Syncing (${state.reason})` : "Syncing");

    if (state.video && state.video !== selectedVideo) {
      setSelectedVideo(state.video);
      pendingRemoteRef.current = state;
      isApplyingRemoteRef.current = false;
      return;
    }

    if (typeof state.playAll === "boolean") {
      setPlayAll(state.playAll);
    }

    if (Math.abs(video.currentTime - state.time) > SYNC_THRESHOLD) {
      video.currentTime = state.time;
    }

    if (video.playbackRate !== state.playbackRate) {
      video.playbackRate = state.playbackRate;
    }

    if (state.paused) {
      video.pause();
    } else {
      video.play().catch(() => {});
    }

    cacheState(state);

    window.setTimeout(() => {
      isApplyingRemoteRef.current = false;
      setSyncState("In sync");
    }, 100);
  }

  function getNextVideo() {
    const playlist = playlistRef.current;
    if (!playlist.length) return null;
    const currentIndex = playlist.indexOf(selectedVideo);
    if (currentIndex === -1) return playlist[0];
    return playlist[(currentIndex + 1) % playlist.length];
  }

  function cacheState(state: PlaybackState) {
    if (!state.video) return;
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

  function restoreCachedState(list: VideoEntry[]) {
    const raw = localStorage.getItem(STATE_CACHE_KEY);
    if (!raw) return;
    let cached: PlaybackState | null = null;
    try {
      cached = JSON.parse(raw);
    } catch {
      return;
    }
    if (!cached?.video) return;
    if (!list.find((entry) => entry.name === cached?.video)) return;
    setSelectedVideo(cached.video);
    setPlayAll(cached.playAll ?? false);
    pendingRemoteRef.current = cached;
  }

  async function checkVersion(shouldReload: boolean) {
    try {
      const response = await fetch(`/api/version?t=${Date.now()}`, { cache: "no-store" });
      const data = await response.json();
      if (!serverVersionRef.current) {
        serverVersionRef.current = data.version;
        return;
      }
      if (data.version && data.version !== serverVersionRef.current && shouldReload) {
        cacheState(collectState());
        location.reload();
      }
    } catch {
      // ignore
    }
  }

  function handleBeforeUnload() {
    cacheState(collectState());
    if (peerConnectionRef.current || localStreamRef.current) {
      socketRef.current?.emit("call-end");
    }
  }

  function appendChatMessage(text: string, sender: string) {
    const message = { text, sender, at: Date.now() };
    setMessages((prev) => [...prev, message]);
    socketRef.current?.emit("chat", message);
  }

  async function startCall() {
    await ensurePeerConnection();
    const offer = await peerConnectionRef.current?.createOffer();
    if (!offer) return;
    await peerConnectionRef.current?.setLocalDescription(offer);
    socketRef.current?.emit("call-offer", { offer });
  }

  async function ensurePeerConnection() {
    if (!localStreamRef.current) {
      localStreamRef.current = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
      if (localCallRef.current) {
        localCallRef.current.srcObject = localStreamRef.current;
      }
    }

    if (!peerConnectionRef.current) {
      peerConnectionRef.current = new RTCPeerConnection({
        iceServers: [{ urls: "stun:stun.l.google.com:19302" }],
      });

      localStreamRef.current.getTracks().forEach((track) => {
        peerConnectionRef.current?.addTrack(track, localStreamRef.current as MediaStream);
      });

      peerConnectionRef.current.ontrack = (event) => {
        if (remoteCallRef.current && remoteCallRef.current.srcObject !== event.streams[0]) {
          remoteCallRef.current.srcObject = event.streams[0];
        }
      };

      peerConnectionRef.current.onicecandidate = (event) => {
        if (event.candidate) {
          socketRef.current?.emit("call-ice", { candidate: event.candidate });
        }
      };
    }
  }

  function endCall() {
    peerConnectionRef.current?.close();
    peerConnectionRef.current = null;
    if (remoteCallRef.current) {
      remoteCallRef.current.srcObject = null;
    }
    if (localStreamRef.current) {
      localStreamRef.current.getTracks().forEach((track) => track.stop());
      localStreamRef.current = null;
      if (localCallRef.current) {
        localCallRef.current.srcObject = null;
      }
    }
  }

  function enableHlsSubtitles(hls: Hls) {
    if (hls.subtitleTracks && hls.subtitleTracks.length > 0) {
      hls.subtitleTrack = 0;
      hls.subtitleDisplay = true;
    }
  }

  function showFirstTextTrack() {
    const video = playerRef.current;
    if (!video?.textTracks || video.textTracks.length === 0) return;
    Array.from(video.textTracks).forEach((track, idx) => {
      track.mode = idx === 0 ? "showing" : "hidden";
    });
  }

  return (
    <main className="shell">
      <header className="header">
        <div className="title-block">
          <p className="subtitle">Two-person playback sync</p>
          <h1>Sync Player</h1>
          <p className="subtitle">Stream videos from the videos/ folder with a shared timeline.</p>
        </div>
        <div className="status">
          <span className={`dot ${status === "Connected" ? "online" : ""}`}></span>
          <span>{status}</span>
        </div>
      </header>

      <section className="controls">
        <label className="field">
          <span>Video</span>
          <select
            value={selectedVideo}
            onChange={(event) => {
              setSelectedVideo(event.target.value);
              pushState("video-change");
            }}
          >
            {videos.length === 0 ? (
              <option value="">No HLS-ready videos</option>
            ) : (
              videos.map((video) => (
                <option key={video.name} value={video.name}>
                  {video.name}
                </option>
              ))
            )}
          </select>
        </label>

        <label className="toggle">
          <input
            type="checkbox"
            checked={playAll}
            onChange={(event) => {
              setPlayAll(event.target.checked);
              pushState("play-all");
            }}
          />
          <span>Play all</span>
        </label>

        <button className="ghost" type="button" onClick={() => socketRef.current?.emit("request-state", { requester: socketRef.current?.id })}>
          Resync
        </button>
      </section>

      <section className="main-grid">
        <div className="player-area">
          <video ref={playerRef} controls preload="metadata" crossOrigin="anonymous" />
          <div className="meta">
            <div>Peers: {peers}</div>
            <div>Sync: {syncState}</div>
          </div>
        </div>

        <div className="chat">
          <div className="call">
            <div className="call-label">Video call</div>
            <div className="call-grid">
              <video ref={localCallRef} autoPlay muted playsInline />
              <video ref={remoteCallRef} autoPlay playsInline />
            </div>
            <div className="call-actions">
              <button className="ghost" type="button" onClick={startCall}>
                Start
              </button>
              <button className="ghost" type="button" onClick={endCall}>
                End
              </button>
            </div>
          </div>

          <div className="chat-header">Chat</div>
          <div className="chat-messages">
            {messages.map((message, index) => (
              <div key={`${message.at}-${index}`} className={`chat-message ${message.sender === socketRef.current?.id ? "mine" : ""}`}>
                <div className="meta">
                  <span>{message.sender === socketRef.current?.id ? "You" : "Peer"}</span>
                  <span>
                    {new Date(message.at).toLocaleTimeString([], {
                      hour: "2-digit",
                      minute: "2-digit",
                    })}
                  </span>
                </div>
                <div className="bubble">{message.text}</div>
              </div>
            ))}
          </div>
          <form
            className="chat-form"
            onSubmit={(event) => {
              event.preventDefault();
              const form = event.currentTarget;
              const input = form.elements.namedItem("message") as HTMLInputElement | null;
              if (!input) return;
              const text = input.value.trim();
              if (!text) return;
              appendChatMessage(text, socketRef.current?.id ?? "local");
              input.value = "";
            }}
          >
            <input name="message" type="text" placeholder="Say something…" autoComplete="off" />
            <button className="primary" type="submit">
              Send
            </button>
          </form>
        </div>
      </section>

      <section className="notes">
        <p>{hlsNote}</p>
      </section>
    </main>
  );
}

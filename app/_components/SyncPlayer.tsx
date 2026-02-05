"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { io, type Socket } from "socket.io-client";
import Hls from "hls.js";

import ThemeToggle from "@/app/_components/ThemeToggle";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";

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
  const requestedVideoRef = useRef<string>("");
  const serverVersionRef = useRef<string | null>(null);
  const localStreamRef = useRef<MediaStream | null>(null);
  const peerConnectionRef = useRef<RTCPeerConnection | null>(null);
  const makingOfferRef = useRef(false);

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
    const socket = io(apiBase);
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
      const pc = peerConnectionRef.current;
      if (!pc) return;
      const readyForOffer = pc.signalingState === "stable" || pc.signalingState === "have-local-offer";
      if (!readyForOffer) {
        try {
          await pc.setLocalDescription({ type: "rollback" });
        } catch {
          // ignore rollback failures
        }
      }
      await pc.setRemoteDescription(offer);
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

    const source = resolveUrl(selectedEntry.hlsMasterPath);

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

  const apiBase = process.env.NEXT_PUBLIC_SERVER_URL ?? "http://localhost:3000";

  async function loadVideos() {
    try {
      const response = await fetch(`${apiBase}/api/videos`, { cache: "no-store" });
      const data = await response.json();
      const list: VideoEntry[] = (data.files ?? []).filter((video: VideoEntry) => video.hls);
      const resolved = list.map((video) => ({
        ...video,
        hlsPath: resolveUrl(video.hlsPath),
        hlsMasterPath: resolveUrl(video.hlsMasterPath ?? video.hlsPath),
      }));
      if (!list.length) {
        setHlsNote("No HLS-ready videos. Run `pnpm hls` and reload.");
        return;
      }
      setVideos(resolved);
      playlistRef.current = resolved.map((entry) => entry.name);
      const initialVideo = requestedVideoRef.current || resolved[0].name;
      setSelectedVideo(initialVideo);
      restoreCachedState(resolved);
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
      requestedVideoRef.current = state.video;
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
      const response = await fetch(`${apiBase}/api/version?t=${Date.now()}`, { cache: "no-store" });
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
    const pc = peerConnectionRef.current;
    if (pc && pc.signalingState !== "closed") return;
    await ensurePeerConnection();
    const connection = peerConnectionRef.current;
    if (!connection) return;
    if (connection.signalingState !== "stable") return;
    makingOfferRef.current = true;
    const offer = await connection.createOffer();
    if (!offer) return;
    await connection.setLocalDescription(offer);
    socketRef.current?.emit("call-offer", { offer });
    makingOfferRef.current = false;
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

      peerConnectionRef.current.onnegotiationneeded = async () => {
        if (!peerConnectionRef.current || makingOfferRef.current) return;
        if (peerConnectionRef.current.signalingState !== "stable") return;
        try {
          makingOfferRef.current = true;
          const offer = await peerConnectionRef.current.createOffer();
          await peerConnectionRef.current.setLocalDescription(offer);
          socketRef.current?.emit("call-offer", { offer });
        } catch {
          // ignore renegotiation errors
        } finally {
          makingOfferRef.current = false;
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
    <main className="layout-shell">
      <header className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <p className="text-xs uppercase tracking-[0.2em] text-muted-foreground">Two-person playback sync</p>
          <h1 className="text-2xl font-semibold">Sync Player</h1>
          <p className="text-sm text-muted-foreground">Stream videos from the videos/ folder with a shared timeline.</p>
        </div>
        <div className="flex items-center gap-3">
          <ThemeToggle />
          <Badge variant="outline" className="flex items-center gap-2">
            <span className={`h-2 w-2 rounded-full ${status === "Connected" ? "bg-foreground" : "bg-muted"}`} />
            {status}
          </Badge>
        </div>
      </header>

      <section className="grid gap-4 md:grid-cols-[minmax(0,1.2fr)_minmax(0,0.6fr)_auto]">
        <Card>
          <CardContent className="flex flex-col gap-2 p-4">
            <span className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Video</span>
            <Select
              value={selectedVideo}
            onValueChange={(value) => {
                requestedVideoRef.current = value;
                setSelectedVideo(value);
                pushState("video-change");
              }}
            >
              <SelectTrigger>
                <SelectValue placeholder="Select video" />
              </SelectTrigger>
              <SelectContent>
                {videos.length === 0 ? (
                  <SelectItem value="none">No HLS-ready videos</SelectItem>
                ) : (
                  videos.map((video) => (
                    <SelectItem key={video.name} value={video.name}>
                      {video.name}
                    </SelectItem>
                  ))
                )}
              </SelectContent>
            </Select>
          </CardContent>
        </Card>

        <Card>
          <CardContent className="flex items-center justify-between gap-3 p-4">
            <div>
              <p className="text-sm font-medium">Play all</p>
              <p className="text-xs text-muted-foreground">Auto-advance to next file.</p>
            </div>
            <Switch
              checked={playAll}
              onCheckedChange={(value) => {
                setPlayAll(value);
                pushState("play-all");
              }}
            />
          </CardContent>
        </Card>

        <Button variant="outline" className="h-full" onClick={() => socketRef.current?.emit("request-state", { requester: socketRef.current?.id })}>
          Resync
        </Button>
      </section>

      <section className="grid gap-6 xl:grid-cols-[minmax(0,4fr)_minmax(0,1fr)]">
        <Card>
          <CardContent className="space-y-4 p-4">
            <video ref={playerRef} controls preload="metadata" crossOrigin="anonymous" className="w-full rounded-lg bg-black" />
            <div className="flex items-center justify-between text-sm text-muted-foreground">
              <span>Peers: {peers}</span>
              <span>Sync: {syncState}</span>
            </div>
          </CardContent>
        </Card>

        <Card className="flex h-full flex-col">
          <CardContent className="flex h-full flex-col gap-4 p-4">
            <div className="space-y-3 rounded-lg border bg-background/60 p-3">
              <div className="text-[10px] uppercase tracking-[0.2em] text-muted-foreground">Video call</div>
              <div className="grid grid-cols-2 gap-2">
                <video ref={localCallRef} autoPlay muted playsInline className="h-20 w-full rounded-md bg-black object-cover" />
                <video ref={remoteCallRef} autoPlay playsInline className="h-20 w-full rounded-md bg-black object-cover" />
              </div>
              <div className="flex gap-2">
                <Button variant="outline" className="flex-1" onClick={startCall}>
                  Start
                </Button>
                <Button variant="outline" className="flex-1" onClick={endCall}>
                  End
                </Button>
              </div>
            </div>

            <div className="flex items-center justify-between">
              <h2 className="text-sm font-semibold">Chat</h2>
              <span className="text-xs text-muted-foreground">{messages.length} messages</span>
            </div>

            <div className="flex-1 space-y-3 overflow-auto rounded-lg border bg-muted/40 p-3">
              {messages.length === 0 ? (
                <p className="text-xs text-muted-foreground">Say hello to start the chat.</p>
              ) : (
                messages.map((message, index) => (
                  <div
                    key={`${message.at}-${index}`}
                    className={`space-y-1 text-xs ${message.sender === socketRef.current?.id ? "text-right" : "text-left"}`}
                  >
                    <div className="text-[10px] text-muted-foreground">
                      {message.sender === socketRef.current?.id ? "You" : "Peer"} ·{" "}
                      {new Date(message.at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
                    </div>
                    <div
                      className={`inline-block max-w-[80%] rounded-md border px-3 py-2 text-sm ${
                        message.sender === socketRef.current?.id
                          ? "bg-foreground text-background"
                          : "bg-background"
                      }`}
                    >
                      {message.text}
                    </div>
                  </div>
                ))
              )}
            </div>

            <form
              className="flex gap-2"
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
              <Input name="message" placeholder="Say something…" autoComplete="off" />
              <Button type="submit">Send</Button>
            </form>
          </CardContent>
        </Card>
      </section>

      {hlsNote ? <p className="text-sm text-muted-foreground">{hlsNote}</p> : null}
    </main>
  );

  function resolveUrl(path: string | null) {
    if (!path) return "";
    if (path.startsWith("http")) return path;
    return `${apiBase}${path}`;
  }
}

import fs from "fs";
import path from "path";

export const runtime = "nodejs";

const VIDEOS_DIR = path.join(process.cwd(), "videos");
const HLS_DIR = path.join(process.cwd(), "hls");

export async function GET() {
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

    return Response.json({ files: payload });
  } catch (_err) {
    return Response.json({ error: "Failed to read videos directory." }, { status: 500 });
  }
}

function isVideoFile(name: string) {
  const ext = path.extname(name).toLowerCase();
  return [".mp4", ".mov", ".webm", ".mkv", ".m4v"].includes(ext);
}

function encodeHlsId(name: string) {
  return Buffer.from(name).toString("base64url");
}

async function fileExists(filePath: string) {
  try {
    await fs.promises.access(filePath, fs.constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

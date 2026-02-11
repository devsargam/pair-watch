import { ExportedHandler, Queue, R2Bucket } from "@cloudflare/workers-types";

export interface Env {
  TORRENT_QUEUE: Queue;
  STATUS_BUCKET: R2Bucket;
  STATUS_PREFIX: string;
  API_TOKEN?: string;
}

type EventMessage = {
  id: string;
  status: string;
  torrentKey?: string;
  hlsKey?: string;
  meta?: Record<string, unknown>;
};

export default {
  async fetch(request: Request, env: Env) {
    if (request.method !== "POST") {
      return new Response("Method Not Allowed", { status: 405 });
    }

    if (!authorize(request, env.API_TOKEN)) {
      return new Response("Unauthorized", { status: 401 });
    }

    let payload: EventMessage | null = null;
    try {
      payload = (await request.json()) as EventMessage;
    } catch {
      payload = null;
    }

    if (!payload?.id || !payload?.status) {
      return new Response("Missing id or status", { status: 400 });
    }

    const record = {
      ...payload,
      updatedAt: new Date().toISOString(),
    };

    const statusKey = `${env.STATUS_PREFIX}/${payload.id}.json`;
    await env.STATUS_BUCKET.put(statusKey, JSON.stringify(record, null, 2), {
      httpMetadata: {
        contentType: "application/json",
        cacheControl: "no-cache",
      },
    });

    await env.TORRENT_QUEUE.send(record);
    return new Response("Queued", { status: 200 });
  },
};

function authorize(request: Request, token?: string) {
  if (!token) return true;
  const header = request.headers.get("authorization");
  if (!header) return false;
  const [scheme, value] = header.split(" ");
  return scheme?.toLowerCase() === "bearer" && value === token;
}

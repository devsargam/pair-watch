import { Queue, R2Bucket } from "@cloudflare/workers-types";

export interface Env {
  TORRENT_QUEUE: Queue;
  STATUS_BUCKET: R2Bucket;
  STATUS_PREFIX: string;
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

    const payloadResult = await parseEventMessage(request);

    if (!payloadResult.ok) {
      return new Response(payloadResult.error, { status: 400 });
    }
    const payload = payloadResult.value;

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

type ParseResult<T> = { ok: true; value: T } | { ok: false; error: string };

async function parseEventMessage(
  request: Request
): Promise<ParseResult<EventMessage>> {
  let data: unknown;
  try {
    data = await request.json();
  } catch {
    return { ok: false, error: "Invalid JSON body" };
  }

  if (!isObject(data)) {
    return { ok: false, error: "Body must be a JSON object" };
  }

  const id = getString(data, "id");
  const status = getString(data, "status");
  if (!id || !status) {
    return { ok: false, error: "Missing or invalid id/status" };
  }

  const torrentKey = getString(data, "torrentKey");
  const hlsKey = getString(data, "hlsKey");
  const meta = isObject(data.meta)
    ? (data.meta as Record<string, unknown>)
    : undefined;

  return {
    ok: true,
    value: { id, status, torrentKey, hlsKey, meta },
  };
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function getString(obj: Record<string, unknown>, key: string) {
  const value = obj[key];
  return typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : undefined;
}

import { err, ok, type Result } from "neverthrow";
import { z } from "zod";

const EnvSchema = z
  .object({
    R2_ACCESS_KEY_ID: z.string().min(1),
    R2_SECRET_ACCESS_KEY: z.string().min(1),
    R2_ENDPOINT: z.string().url(),
    R2_BUCKET: z.string().min(1),
    CF_ACCOUNT_ID: z.string().min(1),
    CF_QUEUE_ID_TORRENT: z.string().min(1),
    CF_API_TOKEN: z.string().min(1),
    SYNC_TORRENTS_PREFIX: z.string().min(1).optional(),
    SYNC_HLS_PREFIX: z.string().min(1).optional(),
    SYNC_WORK_DIR: z.string().min(1).optional(),
    SYNC_CONCURRENCY: z
      .string()
      .regex(/^\d+$/)
      .optional(),
    SYNC_POLL_MS: z
      .string()
      .regex(/^\d+$/)
      .optional(),
    SYNC_BATCH_SIZE: z
      .string()
      .regex(/^\d+$/)
      .optional(),
    SYNC_VISIBILITY_TIMEOUT_MS: z
      .string()
      .regex(/^\d+$/)
      .optional(),
  })
  .passthrough();

export type SyncEnv = {
  accessKeyId: string;
  secretAccessKey: string;
  endpoint: string;
  bucket: string;
  accountId: string;
  queueId: string;
  apiToken: string;
  torrentsPrefix: string;
  hlsPrefix: string;
  workDir: string;
  concurrency: number;
  pollMs: number;
  batchSize: number;
  visibilityTimeoutMs: number;
};

export function loadEnv(): Result<SyncEnv, Error> {
  const parsed = EnvSchema.safeParse(Bun.env);
  if (!parsed.success) {
    return err(new Error(parsed.error.message));
  }

  const env = parsed.data;
  const workDir = env.SYNC_WORK_DIR ?? "sync/work";
  const torrentsPrefix = env.SYNC_TORRENTS_PREFIX ?? "torrents";
  const hlsPrefix = env.SYNC_HLS_PREFIX ?? "hls";
  const concurrency = Number.parseInt(env.SYNC_CONCURRENCY ?? "1", 10) || 1;
  const pollMs = Number.parseInt(env.SYNC_POLL_MS ?? "2000", 10) || 2000;
  const batchSize = Number.parseInt(env.SYNC_BATCH_SIZE ?? "5", 10) || 5;
  const visibilityTimeoutMs =
    Number.parseInt(env.SYNC_VISIBILITY_TIMEOUT_MS ?? "600000", 10) || 600000;

  return ok({
    accessKeyId: env.R2_ACCESS_KEY_ID,
    secretAccessKey: env.R2_SECRET_ACCESS_KEY,
    endpoint: env.R2_ENDPOINT,
    bucket: env.R2_BUCKET,
    accountId: env.CF_ACCOUNT_ID,
    queueId: env.CF_QUEUE_ID_TORRENT,
    apiToken: env.CF_API_TOKEN,
    torrentsPrefix,
    hlsPrefix,
    workDir,
    concurrency,
    pollMs,
    batchSize,
    visibilityTimeoutMs,
  });
}

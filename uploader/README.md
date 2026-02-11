# uploader

Uploads the contents of `../hls` to Cloudflare R2 using Bun's native S3 API.

## Setup

Set env vars:
- `R2_ACCESS_KEY_ID`
- `R2_SECRET_ACCESS_KEY`
- `R2_ENDPOINT` (default: `https://1b4b84195e0f7800867dbb33edb7ec02.r2.cloudflarestorage.com`)
- `R2_BUCKET` (default: `pair-watch`)
- `R2_PREFIX` (optional object prefix)
- `R2_CONCURRENCY` (optional, default `6`)

## Run

```bash
bun install
bun run upload
```

To install dependencies:

```bash
bun install
```

To run:

```bash
bun run index.ts
```

This project was created using `bun init` in bun v1.3.0. [Bun](https://bun.com) is a fast all-in-one JavaScript runtime.

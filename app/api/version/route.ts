export const runtime = "nodejs";

export async function GET() {
  const version = process.env.SERVER_VERSION ?? "";
  return Response.json(
    { version },
    {
      headers: {
        "Cache-Control": "no-store, max-age=0",
      },
    }
  );
}

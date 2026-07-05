import { NextResponse } from "next/server";
import { getServerSnapshot } from "@/lib/server/okx-cache";

export const dynamic = "force-dynamic";
export const revalidate = 0;
export const runtime = "nodejs";

export async function GET() {
  const snapshot = await getServerSnapshot();

  return NextResponse.json(snapshot, {
    headers: {
      "Cache-Control": "no-store, max-age=0"
    }
  });
}

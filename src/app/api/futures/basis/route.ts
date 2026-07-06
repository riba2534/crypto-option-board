import { NextResponse } from "next/server";
import { getFuturesBasisSnapshot } from "@/lib/server/binance-basis-cache";

export const dynamic = "force-dynamic";
export const revalidate = 0;
export const runtime = "nodejs";

export async function GET() {
  const snapshot = await getFuturesBasisSnapshot();

  return NextResponse.json(snapshot, {
    headers: {
      "Cache-Control": "no-store, max-age=0"
    }
  });
}

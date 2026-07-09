import { NextResponse } from "next/server";
import { getFuturesBasisHealth } from "@/lib/server/futures-basis-cache";

export const dynamic = "force-dynamic";
export const revalidate = 0;
export const runtime = "nodejs";

export function GET() {
  return NextResponse.json(getFuturesBasisHealth(), {
    headers: {
      "Cache-Control": "no-store, max-age=0"
    }
  });
}

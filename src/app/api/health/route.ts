import { NextResponse } from "next/server";
import { getCacheHealth } from "@/lib/server/okx-cache";

export const dynamic = "force-dynamic";
export const revalidate = 0;
export const runtime = "nodejs";

export function GET() {
  return NextResponse.json(getCacheHealth(), {
    headers: {
      "Cache-Control": "no-store, max-age=0"
    }
  });
}

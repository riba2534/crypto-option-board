import { Dashboard } from "@/components/dashboard";
import { getServerSnapshot } from "@/lib/server/okx-cache";

export const dynamic = "force-dynamic";
export const revalidate = 0;

export default async function Home() {
  const snapshot = await getServerSnapshot();

  return <Dashboard initialSnapshot={snapshot} />;
}

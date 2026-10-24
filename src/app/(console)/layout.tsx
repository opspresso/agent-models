import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { runtime } from "../../lib/runtime.ts";
import { isRouterError } from "../../domain/router/errors.ts";
import { Shell } from "../_components/shell.tsx";
export default async function ConsoleLayout({ children }: { children: React.ReactNode }) {
  const app = await runtime();
  let user;
  try { user = await app.session(new Headers(await headers())); }
  catch (error) { if (isRouterError(error) && error.status === 401) redirect("/login"); throw error; }
  if (!user) redirect("/login");
  return <Shell user={user} studioUrl={app.config.issuer.replace(/\/api\/auth\/?$/, "")}>{children}</Shell>;
}

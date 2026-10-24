import { runtime } from "../../lib/runtime.ts";
import { Login } from "./sign-in.tsx";
export default async function LoginPage() { const app = await runtime(); return <Login providerId={app.config.providerId} />; }

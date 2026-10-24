"use client";
import { useState } from "react";
import { Alert, Button, Card, Center, Container, Image, Stack, Text, Title } from "@mantine/core";
import { authClient } from "../../lib/auth-client.ts";
import { useT } from "../providers.tsx";
export function Login({ providerId }: { providerId: string }) {
  const t = useT(); const [busy, setBusy] = useState(false); const [error, setError] = useState(false);
  async function signIn() {
    setBusy(true); setError(false);
    try { const result = await authClient.signIn.social({ provider: providerId, callbackURL: "/" }); if (result.error || !result.data?.url) throw new Error(); }
    catch { setError(true); setBusy(false); }
  }
  return <Container size="xs"><Center mih="90dvh"><Card p="xl" w="100%"><Stack align="center" gap="lg" ta="center">
    <Image src="/logo.png" alt="" w={48} h={48} /><Text fw={650}>Agent Models</Text><Title order={1} size="h2">{t("loginTitle")}</Title>
    <Text size="sm" c="dimmed">{t("loginDescription")}</Text><Text size="sm">{t("loginHint")}</Text>
    {error && <Alert color="red" role="alert">{t("signInFailed")}</Alert>}<Button fullWidth loading={busy} onClick={() => void signIn()}>{t("signIn")}</Button>
    <Text size="xs" c="dimmed">© OpsPresso</Text>
  </Stack></Card></Center></Container>;
}

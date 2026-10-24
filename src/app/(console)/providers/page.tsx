"use client";
import { useState } from "react";
import { mayManage } from "../../../domain/identity.ts";
import { Badge, Button, Card, Group, Modal, PasswordInput, Select, SimpleGrid, Stack, Switch, Text, TextInput, Title } from "@mantine/core";
import { IconPlus } from "@tabler/icons-react";
import { PROVIDER_KINDS, type Provider } from "../../../domain/router/types.ts";
import { api, useRemote } from "../../api-client.ts";
import { useT } from "../../providers.tsx";
import { useViewer } from "../../_components/shell.tsx";
import { Failure, Loading } from "../../_components/state.tsx";

export default function ProvidersPage() {
  const t = useT(); const user = useViewer(); const providers = useRemote<Provider[]>(mayManage(user) ? "/api/providers" : null);
  const [editing, setEditing] = useState<{ token: string; value: Provider | "new" } | null>(null);
  if (!mayManage(user)) return <Failure message={t("adminOnly")} />;
  return <Stack gap="lg"><Group justify="space-between"><div><Title order={1}>{t("providers")}</Title><Text c="dimmed" size="sm">{t("providerDescription")}</Text></div><Button leftSection={<IconPlus size={16} />} onClick={() => setEditing({ token: crypto.randomUUID(), value: "new" })}>{t("addProvider")}</Button></Group>
    {providers.error ? <Failure message={providers.error} retry={providers.reload} /> : !providers.data ? <Loading /> : <>
      {providers.data.length === 0 && <Card><Text c="dimmed">{t("emptyProviders")}</Text></Card>}
      <SimpleGrid cols={{ base: 1, md: 2, xl: 3 }}>{providers.data.map(provider => <Card key={provider.id}><Stack gap="sm"><Group justify="space-between"><Text fw={600}>{provider.name}</Text><Badge color={provider.enabled ? "blue" : "gray"}>{t(provider.enabled ? "enabled" : "disabled")}</Badge></Group>
        <Text size="sm" c="dimmed">{provider.kind} · {provider.id}</Text><Text size="sm" className="models-wrap">{provider.baseUrl}</Text><Group justify="space-between"><Badge variant="outline">{provider.auth === "secret" ? t("credential") : t(provider.auth)}</Badge><Button variant="default" size="xs" onClick={() => setEditing({ token: crypto.randomUUID(), value: provider })}>{t("edit")}</Button></Group>
      </Stack></Card>)}</SimpleGrid>
    </>}
    <Modal opened={editing !== null} onClose={() => setEditing(null)} title={t("providerForm")} size="lg">{editing && <ProviderForm key={editing.token} initial={editing.value === "new" ? undefined : editing.value} onSave={() => { setEditing(current => current?.token === editing.token ? null : current); providers.reload(); }} onCancel={() => setEditing(null)} />}</Modal>
  </Stack>;
}

function ProviderForm({ initial, onSave, onCancel }: { initial?: Provider | undefined; onSave(): void; onCancel(): void }) {
  const t = useT(); const [id, setId] = useState(initial?.id ?? ""); const [name, setName] = useState(initial?.name ?? "");
  const [kind, setKind] = useState<Provider["kind"]>(initial?.kind ?? "openai"); const [baseUrl, setBaseUrl] = useState(initial?.baseUrl ?? "");
  const [auth, setAuth] = useState<Provider["auth"]>(initial?.auth ?? "secret"); const [secret, setSecret] = useState("");
  const [enabled, setEnabled] = useState(initial?.enabled ?? true); const [busy, setBusy] = useState(false); const [error, setError] = useState<string>();
  async function submit(event: React.FormEvent) {
    event.preventDefault(); setBusy(true); setError(undefined);
    try { await api("/api/providers", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ revision: initial?.revision ?? null, provider: { id, name, kind, baseUrl, auth, enabled, ...(auth === "secret" && secret ? { secret } : {}) } }) }); onSave(); }
    catch (reason) { setError(reason instanceof Error ? reason.message : t("failed")); }
    finally { setBusy(false); }
  }
  return <form onSubmit={event => void submit(event)}><Stack>
    {error && <Failure message={error} />}<Group grow><TextInput label={t("id")} value={id} onChange={event => setId(event.currentTarget.value)} required disabled={!!initial || busy} pattern="[a-z][a-z0-9_-]{0,63}" /><TextInput label={t("name")} value={name} onChange={event => setName(event.currentTarget.value)} required disabled={busy} /></Group>
    <Select label={t("kind")} value={kind} data={[...PROVIDER_KINDS]} allowDeselect={false} onChange={value => { if (value) setKind(value as Provider["kind"]); }} disabled={busy} />
    <TextInput label={t("endpoint")} placeholder="https://api.example.com/v1" type="url" value={baseUrl} onChange={event => setBaseUrl(event.currentTarget.value)} required disabled={busy} />
    <Select label={t("auth")} value={auth} data={[{ value: "secret", label: t("credential") }, { value: "none", label: t("none") }, ...(kind === "bedrock" ? [{ value: "sigv4", label: t("sigv4") }] : [])]} allowDeselect={false} onChange={value => { if (value) { setAuth(value as Provider["auth"]); setSecret(""); } }} disabled={busy} />
    {auth === "secret" && <div data-helper-private><PasswordInput label={t("credential")} description={initial ? t("preserveSecret") : undefined} value={secret} onChange={event => setSecret(event.currentTarget.value)} required={!initial} autoComplete="new-password" disabled={busy} visibilityToggleFocusable /></div>}
    <Switch label={t("enabled")} checked={enabled} onChange={event => setEnabled(event.currentTarget.checked)} disabled={busy} /><Group justify="flex-end"><Button variant="default" onClick={onCancel} disabled={busy}>{t("cancel")}</Button><Button type="submit" loading={busy}>{t("save")}</Button></Group>
  </Stack></form>;
}

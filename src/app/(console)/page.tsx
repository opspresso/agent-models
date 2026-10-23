"use client";
import { useState } from "react";
import { mayManage } from "../../domain/identity.ts";
import { Badge, Button, Card, Group, Modal, Select, SimpleGrid, Stack, Table, Tabs, Text, TextInput, Title } from "@mantine/core";
import { IconSearch } from "@tabler/icons-react";
import { MODEL_TYPES, type DiscoveredModel, type Provider, type SelectedModel, type SelectedModelView } from "../../domain/router/types.ts";
import { api, useRemote } from "../api-client.ts";
import { useLocale, useT } from "../providers.tsx";
import { useViewer } from "../_components/shell.tsx";
import { Failure, Loading } from "../_components/state.tsx";
import { ModelForm } from "../_components/model-form.tsx";

export default function ModelsPage() {
  const t = useT(); const locale = useLocale(); const user = useViewer();
  const selected = useRemote<SelectedModelView[]>(`/api/models${mayManage(user) ? "?all=true" : ""}`);
  const providers = useRemote<Provider[]>(mayManage(user) ? "/api/providers" : null);
  const [search, setSearch] = useState(""); const [type, setType] = useState<string | null>(null);
  const [editing, setEditing] = useState<{ token: string; value: SelectedModel | DiscoveredModel } | null>(null);
  const edit = (value: SelectedModel | DiscoveredModel) => setEditing({ token: crypto.randomUUID(), value });
  const models = selected.data?.filter(model => (!type || model.type === type) && `${model.id} ${model.displayName} ${model.providerId}`.toLowerCase().includes(search.toLowerCase()));
  const count = (value: number) => new Intl.NumberFormat(locale).format(value);
  return <Stack gap="lg"><Group justify="space-between"><div><Title order={1}>{t("models")}</Title><Text size="sm" c="dimmed">{t("modelDescription")}</Text></div>{mayManage(user) && <Button disabled={!providers.data?.length} onClick={() => edit({ providerId: providers.data![0]!.id, wireId: "", displayName: "", available: true, observedAt: new Date().toISOString() })}>{t("addModel")}</Button>}</Group>
    <Tabs defaultValue="selected"><Tabs.List><Tabs.Tab value="selected">{t("selected")} {selected.data && <Badge size="xs" ml={4}>{selected.data.length}</Badge>}</Tabs.Tab>{mayManage(user) && <Tabs.Tab value="discovered">{t("discovered")}</Tabs.Tab>}</Tabs.List>
      <Tabs.Panel value="selected" pt="lg"><Stack>
        <Group><TextInput aria-label={t("search")} placeholder={t("search")} leftSection={<IconSearch size={16} />} value={search} onChange={event => setSearch(event.currentTarget.value)} style={{ flex: 1, minWidth: 180 }} /><Select aria-label={t("type")} placeholder={t("allTypes")} data={[...MODEL_TYPES]} value={type} onChange={setType} clearable /></Group>
        {selected.error ? <Failure message={selected.error} retry={selected.reload} /> : !models ? <Loading /> : <>
          {models.length === 0 && <Card><Text c="dimmed">{t("emptyModels")}</Text></Card>}
          <SimpleGrid cols={{ base: 1, md: 2, xl: 3 }}>{models.map(model => <Card key={model.id}><Stack gap="sm">
            <Group justify="space-between" align="start" wrap="nowrap"><div className="models-wrap"><Text fw={600}>{model.displayName}</Text><Text size="xs" c="dimmed">{model.id}</Text></div><Badge color={model.enabled && model.providerEnabled ? "blue" : "gray"}>{t(model.enabled && model.providerEnabled ? "enabled" : "disabled")}</Badge></Group>
            <Group gap="xs"><Badge>{model.type}</Badge><Badge variant="outline">{model.providerId}</Badge></Group>
            <Group gap="xs">{(["tools", "structuredOutput", "imageInput", "reasoning"] as const).filter(key => model.capabilities[key]).map(key => <Text key={key} size="xs" c="dimmed">{t(key)}</Text>)}</Group>
            <Group justify="space-between"><Text size="xs" c="dimmed">{t("context")}</Text><Text size="sm">{count(model.contextWindow)}</Text></Group>
            <Group justify="space-between"><Text size="xs" c="dimmed">{t("pricing")}</Text><Text size="sm">{model.pricing ? `$${model.pricing.inputPer1M} / $${model.pricing.outputPer1M} · 1M` : t("unknown")}</Text></Group>
            {mayManage(user) && <Group justify="flex-end"><Button variant="default" size="xs" onClick={() => edit(model)}>{t("edit")}</Button></Group>}
          </Stack></Card>)}</SimpleGrid>
        </>}
      </Stack></Tabs.Panel>
      {mayManage(user) && <Tabs.Panel value="discovered" pt="lg">{providers.error ? <Failure message={providers.error} retry={providers.reload} /> : !providers.data ? <Loading /> : <Discovery providers={providers.data} selected={selected.data ?? []} select={edit} />}</Tabs.Panel>}
    </Tabs>
    <Modal opened={editing !== null} onClose={() => setEditing(null)} title={t("modelForm")} size="xl">{editing && providers.data && <ModelForm key={editing.token} initial={editing.value} providers={providers.data} onSave={() => { setEditing(current => current?.token === editing.token ? null : current); selected.reload(); }} onCancel={() => setEditing(null)} />}</Modal>
  </Stack>;
}

function Discovery({ providers, selected, select }: { providers: Provider[]; selected: SelectedModel[]; select(value: DiscoveredModel): void }) {
  const t = useT(); const [choice, setChoice] = useState<string | null>(null); const providerId = choice ?? providers[0]?.id;
  const [after, setAfter] = useState<string>(); const [history, setHistory] = useState<Array<string | undefined>>([]);
  const discovered = useRemote<DiscoveredModel[]>(providerId ? `/api/discovered?provider=${encodeURIComponent(providerId)}${after ? `&after=${encodeURIComponent(after)}` : ""}` : null);
  const [busy, setBusy] = useState(false); const [error, setError] = useState<string>(); const [collected, setCollected] = useState(false);
  async function collect() {
    if (!providerId) return;
    setBusy(true); setError(undefined); setCollected(false);
    try { await api(`/api/providers/${encodeURIComponent(providerId)}/discover`, { method: "POST" }); setAfter(undefined); setHistory([]); discovered.reload(); setCollected(true); }
    catch (reason) { setError(reason instanceof Error ? reason.message : t("failed")); }
    finally { setBusy(false); }
  }
  if (!providerId) return <Card><Text c="dimmed">{t("emptyProviders")}</Text></Card>;
  return <Stack><Group align="end"><Select label={t("provider")} data={providers.map(provider => ({ value: provider.id, label: provider.name }))} value={providerId} onChange={value => { setChoice(value); setAfter(undefined); setHistory([]); setCollected(false); }} allowDeselect={false} style={{ flex: 1, minWidth: 200 }} disabled={busy} /><Button onClick={() => void collect()} loading={busy}>{t("collect")}</Button></Group>
    {collected && <Text size="sm" c="green" role="status">{t("collectSuccess")}</Text>}{error && <Failure message={error} />}
    {discovered.error ? <Failure message={discovered.error} retry={discovered.reload} /> : !discovered.data ? <Loading /> : <>
      {discovered.data.length === 0 ? <Card><Text c="dimmed">{t("emptyDiscovery")}</Text></Card> : <Table.ScrollContainer minWidth={600}><Table verticalSpacing="sm"><Table.Thead><Table.Tr><Table.Th>{t("name")}</Table.Th><Table.Th>{t("type")}</Table.Th><Table.Th>{t("context")}</Table.Th><Table.Th>{t("state")}</Table.Th><Table.Th /></Table.Tr></Table.Thead><Table.Tbody>{discovered.data.map(model => {
        const enrolled = selected.some(value => value.providerId === model.providerId && value.wireId === model.wireId);
        return <Table.Tr key={model.wireId}><Table.Td><Text size="sm" fw={500}>{model.displayName}</Text><Text size="xs" c="dimmed" className="models-wrap">{model.wireId}</Text></Table.Td><Table.Td><Badge>{model.type ?? t("unknown")}</Badge></Table.Td><Table.Td>{model.contextWindow ?? "—"}</Table.Td><Table.Td><Badge color={model.available ? "blue" : "gray"}>{t(model.available ? "available" : "unavailable")}</Badge></Table.Td><Table.Td><Button variant="default" size="xs" disabled={enrolled || !model.available} onClick={() => select(model)}>{t(enrolled ? "selected" : "select")}</Button></Table.Td></Table.Tr>;
      })}</Table.Tbody></Table></Table.ScrollContainer>}
      <Group justify="flex-end"><Button variant="default" disabled={history.length === 0} onClick={() => { setAfter(history.at(-1)); setHistory(previous => previous.slice(0, -1)); }}>{t("previous")}</Button><Button variant="default" disabled={discovered.data.length < 100} onClick={() => { setHistory(previous => [...previous, after]); setAfter(discovered.data!.at(-1)!.wireId); }}>{t("next")}</Button></Group>
    </>}
  </Stack>;
}

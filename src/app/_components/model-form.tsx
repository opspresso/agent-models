"use client";
import { useState } from "react";
import { Accordion, Button, Checkbox, Group, MultiSelect, NumberInput, Select, SimpleGrid, Stack, Switch, Text, TextInput } from "@mantine/core";
import { MODEL_TYPES, OPERATIONS, type DiscoveredModel, type ModelType, type Operation, type Pricing, type Provider, type SelectedModel } from "../../domain/router/types.ts";
import { operationsForType } from "../../domain/router/validation.ts";
import { api } from "../api-client.ts";
import { useT } from "../providers.tsx";
import { Failure } from "./state.tsx";
const priceKeys = ["inputPer1M", "outputPer1M", "cachedInputPer1M", "cacheWriteInputPer1M", "imageInputPer1M", "imageOutputPer1M", "perImage", "perInputImage", "perSearch", "perAudioMinute"] as const;
export function ModelForm({ initial, providers, onSave, onCancel }: { initial: SelectedModel | DiscoveredModel; providers: Provider[]; onSave(): void; onCancel(): void }) {
  const t = useT(); const editing = "revision" in initial; const [providerId, setProviderId] = useState(initial.providerId); const provider = providers.find(value => value.id === providerId);
  const [id, setId] = useState("id" in initial ? initial.id : `${initial.providerId}/${initial.family ?? initial.wireId}`);
  const [name, setName] = useState(initial.displayName); const [wireId, setWireId] = useState(initial.wireId);
  const [type, setType] = useState<ModelType | null>(initial.type ?? null); const [context, setContext] = useState<number | string>(initial.contextWindow ?? "");
  const [output, setOutput] = useState<number | string>(initial.maxTokens ?? ""); const [enabled, setEnabled] = useState("enabled" in initial ? initial.enabled : true);
  const defaults = (kind: ModelType | undefined): Operation[] => kind === "text" ? ["chat/completions"] : kind === "image" ? [provider?.kind === "openrouter" ? "images" : "images/generations"] : kind === "embedding" ? ["embeddings"] : kind === "rerank" ? ["rerank"] : kind === "transcription" ? ["audio/transcriptions"] : kind === "decision" ? ["decisions"] : [];
  const [operations, setOperations] = useState<string[]>("operations" in initial ? initial.operations : defaults(initial.type));
  const [capabilities, setCapabilities] = useState({ tools: false, structuredOutput: false, imageInput: false, reasoning: false, ...initial.capabilities });
  const [known, setKnown] = useState(initial.pricing != null); const [rates, setRates] = useState<Record<string, string>>(Object.fromEntries(priceKeys.map(key => [key, initial.pricing?.[key]?.toString() ?? ""])));
  const [busy, setBusy] = useState(false); const [error, setError] = useState<string>();
  async function submit(event: React.FormEvent) {
    event.preventDefault(); setError(undefined);
    if (!type) return;
    let pricing: Pricing | null = null;
    if (known) {
      if (!rates.inputPer1M?.trim() || !rates.outputPer1M?.trim() || Object.values(rates).some(value => value && (!Number.isFinite(Number(value)) || Number(value) < 0))) { setError(t("invalidPrice")); return; }
      pricing = Object.fromEntries(Object.entries(rates).filter(([, value]) => value !== "").map(([key, value]) => [key, Number(value)])) as unknown as Pricing;
    }
    setBusy(true);
    try {
      const model = { id, providerId, wireId, displayName: name, type, contextWindow: Number(context), maxTokens: Number(output), enabled, operations, capabilities: {
        tools: capabilities.tools, structuredOutput: capabilities.structuredOutput, imageInput: capabilities.imageInput, reasoning: capabilities.reasoning,
        ...(capabilities.reasoningWithTools !== undefined ? { reasoningWithTools: capabilities.reasoningWithTools } : {}),
      }, pricing, ...(initial.catalogId ? { catalogId: initial.catalogId } : {}), ...(initial.maker ? { maker: initial.maker } : {}), ...(initial.family ? { family: initial.family } : {}) };
      await api("/api/models", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ model, revision: editing ? initial.revision : null }) }); onSave();
    } catch (reason) { setError(reason instanceof Error ? reason.message : t("failed")); }
    finally { setBusy(false); }
  }
  return <form onSubmit={event => void submit(event)}><Stack>
    {error && <Failure message={error} />}<Select label={t("provider")} value={providerId} data={providers.map(value => ({ value: value.id, label: value.name }))} allowDeselect={false} disabled={busy} onChange={value => { if (value) { if (!editing && id === `${providerId}/${wireId}`) setId(`${value}/${wireId}`); setProviderId(value); } }} />
    <TextInput label={t("id")} value={id} disabled={editing || busy} onChange={event => setId(event.currentTarget.value)} required />
    <Group grow><TextInput label={t("name")} value={name} onChange={event => setName(event.currentTarget.value)} required disabled={busy} /><TextInput label={t("wireId")} value={wireId} onChange={event => { const value = event.currentTarget.value; if (!editing && id === `${providerId}/${wireId}`) setId(`${providerId}/${value}`); if (name === wireId) setName(value); setWireId(value); }} required disabled={busy} /></Group>
    <Select label={t("type")} value={type} data={[...MODEL_TYPES]} onChange={value => { setType(value as ModelType | null); setOperations(defaults(value as ModelType)); if (value === "embedding" || value === "rerank") setOutput(0); }} required disabled={busy} />
    <Group grow><NumberInput label={t("context")} min={0} allowDecimal={false} value={context} onChange={setContext} required disabled={busy} /><NumberInput label={t("output")} min={0} allowDecimal={false} value={output} onChange={setOutput} required disabled={busy} /></Group>
    <MultiSelect label={t("operations")} data={type ? operationsForType(type) : [...OPERATIONS]} value={operations} onChange={setOperations} searchable withAsterisk disabled={busy} />
    <SimpleGrid cols={{ base: 2, sm: 4 }}>{(["tools", "structuredOutput", "imageInput", "reasoning"] as const).map(key => <Checkbox key={key} label={t(key)} checked={capabilities[key]} onChange={event => { const checked = event.currentTarget.checked; setCapabilities(previous => ({ ...previous, [key]: checked })); }} disabled={busy} />)}</SimpleGrid>
    <Accordion variant="contained" defaultValue={known ? "pricing" : null}><Accordion.Item value="pricing"><Accordion.Control>{t("pricing")}</Accordion.Control><Accordion.Panel><Stack gap="sm">
      <Text size="xs" c="dimmed">{t("pricingHint")}</Text><Switch label={t("priceKnown")} checked={known} onChange={event => setKnown(event.currentTarget.checked)} disabled={busy} />
      {known && <SimpleGrid cols={{ base: 1, sm: 2 }}>{priceKeys.map(key => <NumberInput key={key} label={t(key)} min={0} value={rates[key] ?? ""} onChange={value => setRates(previous => ({ ...previous, [key]: String(value) }))} required={key === "inputPer1M" || key === "outputPer1M"} disabled={busy} />)}</SimpleGrid>}
    </Stack></Accordion.Panel></Accordion.Item></Accordion>
    <Switch label={t("enabled")} checked={enabled} onChange={event => setEnabled(event.currentTarget.checked)} disabled={busy} /><Group justify="flex-end"><Button variant="default" onClick={onCancel} disabled={busy}>{t("cancel")}</Button><Button type="submit" loading={busy} disabled={!type || operations.length === 0}>{t("save")}</Button></Group>
  </Stack></form>;
}

"use client";
import { useState } from "react";
import { Badge, Button, Card, Group, Select, SimpleGrid, Stack, Table, Text, TextInput, Title } from "@mantine/core";
import { USAGE_UNITS, type UsageQuery, type UsageOverview } from "../../../domain/router/types.ts";
import { useRemote } from "../../api-client.ts";
import { useLocale, useT } from "../../providers.tsx";
import { Failure, Loading } from "../../_components/state.tsx";

export default function UsagePage() {
  const t = useT(); const locale = useLocale(); const now = new Date();
  const [from, setFrom] = useState(`${now.toISOString().slice(0, 7)}-01`); const [to, setTo] = useState(now.toISOString().slice(0, 10));
  const [groupBy, setGroupBy] = useState<UsageQuery["groupBy"]>("model"); const [after, setAfter] = useState<string>(); const [history, setHistory] = useState<Array<string | undefined>>([]);
  const fromTime = Date.parse(`${from}T00:00:00Z`), toTime = Date.parse(`${to}T00:00:00Z`);
  const valid = Number.isFinite(fromTime) && Number.isFinite(toTime) && fromTime <= toTime && toTime - fromTime < 366 * 86400_000 && Number.isFinite(new Date(toTime + 86400_000).getTime());
  const query = new URLSearchParams({ from: `${from}T00:00:00.000Z`, to: valid ? new Date(Date.parse(`${to}T00:00:00Z`) + 86400_000).toISOString() : "", groupBy, limit: "100", ...(after ? { after } : {}) });
  const usage = useRemote<UsageOverview>(valid ? `/api/usage?${query}` : null);
  const rows = usage.data?.groups;
  const total = usage.data?.totals;
  const number = (value: number) => new Intl.NumberFormat(locale, { maximumFractionDigits: 4 }).format(value);
  const money = (value: number) => value > 0 && value < 0.000001 ? "< $0.000001" : new Intl.NumberFormat(locale, { style: "currency", currency: "USD", maximumFractionDigits: 6 }).format(value);
  const reset = () => { setAfter(undefined); setHistory([]); };
  const units = USAGE_UNITS.filter(unit => rows?.some(row => row.usage[unit] !== undefined));
  return <Stack gap="lg"><div><Title order={1}>{t("usage")}</Title><Text size="sm" c="dimmed">{t("usageDescription")}</Text></div>
    <SimpleGrid cols={{ base: 1, sm: 3 }} maw={900}><TextInput type="date" label={t("from")} value={from} onChange={event => { setFrom(event.currentTarget.value); reset(); }} /><TextInput type="date" label={t("to")} value={to} onChange={event => { setTo(event.currentTarget.value); reset(); }} /><Select label={t("groupBy")} data={[{ value: "model", label: t("models") }, { value: "user", label: t("user") }, { value: "agent", label: t("agent") }, { value: "service", label: t("service") }, { value: "day", label: t("day") }]} value={groupBy} allowDeselect={false} onChange={value => { if (value) setGroupBy(value as UsageQuery["groupBy"]); reset(); }} /></SimpleGrid>
    {!valid ? <Failure message={t("invalidPeriod")} /> : usage.error ? <Failure message={usage.error} retry={usage.reload} /> : !rows || !total ? <Loading /> : <>
      <SimpleGrid cols={{ base: 2, md: 4 }}>{([{ label: t("requests"), value: number(total.requests) }, { label: t("cost"), value: money(total.costUsd) }, { label: t("unpriced"), value: number(total.unpriced) }, { label: t("measured"), value: `${number(total.measuredRequests)} / ${number(total.requests)}` }]).map(card => <Card key={card.label}><Text size="sm" c="dimmed">{card.label}</Text><Text className="models-metric" fw={650} mt="xs">{card.value}</Text></Card>)}</SimpleGrid>
      {rows.length === 0 ? <Card><Text c="dimmed">{t("noUsage")}</Text></Card> : <Table.ScrollContainer minWidth={650}><Table verticalSpacing="sm"><Table.Thead><Table.Tr><Table.Th>{t("groupBy")}</Table.Th><Table.Th>{t("requests")}</Table.Th><Table.Th>{t("cost")}</Table.Th><Table.Th>{t("unpriced")}</Table.Th>{units.map(unit => <Table.Th key={unit}>{["inputTokens", "outputTokens", "images", "audioSeconds"].includes(unit) ? t(unit as "inputTokens" | "outputTokens" | "images" | "audioSeconds") : unit}</Table.Th>)}</Table.Tr></Table.Thead><Table.Tbody>{rows.map(row => <Table.Tr key={row.key ?? "none"}><Table.Td><Text size="sm" className="models-wrap">{row.key ?? "—"}</Text></Table.Td><Table.Td>{number(row.requests)}</Table.Td><Table.Td>{money(row.costUsd)}</Table.Td><Table.Td><Badge color={row.unpriced ? "yellow" : "gray"}>{row.unpriced}</Badge></Table.Td>{units.map(unit => <Table.Td key={unit}><Text size="sm">{row.usage[unit] ? number(row.usage[unit].total) : "—"}</Text>{row.usage[unit] && row.usage[unit].observedRequests < row.requests && <Text size="xs" c="dimmed">{row.usage[unit].observedRequests}/{row.requests}</Text>}</Table.Td>)}</Table.Tr>)}</Table.Tbody></Table></Table.ScrollContainer>}
      <Group justify="flex-end"><Button variant="default" disabled={history.length === 0} onClick={() => { setAfter(history.at(-1)); setHistory(previous => previous.slice(0, -1)); }}>{t("previous")}</Button><Button variant="default" disabled={rows.length < 100 || rows.at(-1)?.key == null} onClick={() => { setHistory(previous => [...previous, after]); setAfter(rows!.at(-1)!.key!); }}>{t("next")}</Button></Group>
    </>}
  </Stack>;
}

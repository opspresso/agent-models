"use client";
import { Alert, Button, Group, Loader, Text } from "@mantine/core";
import { useT } from "../providers.tsx";
export function Loading() { const t = useT(); return <Group role="status" py="lg"><Loader size="sm" /><Text c="dimmed" size="sm">{t("loading")}</Text></Group>; }
export function Failure({ message, retry }: { message: string; retry?: () => void }) { const t = useT(); return <Alert color="red" role="alert"><Group justify="space-between"><Text size="sm">{message}</Text>{retry && <Button variant="light" size="xs" onClick={retry}>{t("retry")}</Button>}</Group></Alert>; }

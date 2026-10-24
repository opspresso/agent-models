"use client";
import { Card, Stack, Text, Title } from "@mantine/core";
import { useViewer } from "../../_components/shell.tsx";
import { useT } from "../../providers.tsx";
export default function Profile() { const user = useViewer(); const t = useT(); return <Stack><Title order={1}>{t("profile")}</Title><Text c="dimmed">{t("permissionHint")}</Text><Card><Stack>
  <Text fw={600}>{user.name}</Text><Text>{user.email}</Text><Text size="sm">{user.tier}</Text><Text size="xs" c="dimmed">{t("requestIdentity")}</Text><Text size="sm" className="models-wrap">{user.subject}</Text>
</Stack></Card></Stack>; }

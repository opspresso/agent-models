"use client";
import { Alert, Button, Container, Stack } from "@mantine/core";
import { useT } from "./providers.tsx";
export default function ErrorPage({ reset }: { reset(): void }) { const t = useT(); return <Container size="sm" py="xl"><Stack><Alert color="red">{t("failed")}</Alert><Button onClick={reset}>{t("retry")}</Button></Stack></Container>; }

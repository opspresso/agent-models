"use client";
import { createContext, useContext, useState } from "react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { ActionIcon, Alert, AppShell, Avatar, Burger, Drawer, Group, Image, Menu, NavLink, Stack, Text, UnstyledButton, useMantineColorScheme } from "@mantine/core";
import { useMediaQuery } from "@mantine/hooks";
import { IconAdjustments, IconChartBar, IconCpu, IconLanguage, IconLogout, IconSunMoon, IconUser } from "@tabler/icons-react";
import { mayManage, type AuthenticatedPrincipal } from "../../domain/identity.ts";
import { authClient } from "../../lib/auth-client.ts";
import { useLocale, useT } from "../providers.tsx";
const UserContext = createContext<AuthenticatedPrincipal | null>(null);
export function useViewer() { const user = useContext(UserContext); if (!user) throw new Error("Viewer context is missing"); return user; }
export function Shell({ user, studioUrl, children }: { user: AuthenticatedPrincipal; studioUrl: string; children: React.ReactNode }) {
  const t = useT(); const language = useLocale(); const router = useRouter(); const pathname = usePathname();
  const [opened, setOpened] = useState(false); const [error, setError] = useState(false); const { toggleColorScheme } = useMantineColorScheme();
  const desktop = useMediaQuery("(min-width: 48em)");
  const links = [{ href: "/", key: "models" as const, Icon: IconCpu }, ...(mayManage(user) ? [{ href: "/providers", key: "providers" as const, Icon: IconAdjustments }] : []), { href: "/usage", key: "usage" as const, Icon: IconChartBar }];
  const navigation = <nav>{links.map(({ href, key, Icon }) => <NavLink key={href} component={Link} href={href} label={t(key)} leftSection={<Icon size={18} />} active={pathname === href} onClick={() => setOpened(false)} />)}</nav>;
  return <UserContext.Provider value={user}><AppShell header={{ height: 60 }} navbar={{ width: 224, breakpoint: "sm", collapsed: { mobile: true } }} padding="lg" transitionDuration={0}>
    <AppShell.Header><Group h="100%" px="md" justify="space-between" wrap="nowrap"><Group gap="sm" wrap="nowrap">
      <Burger opened={opened} onClick={() => setOpened(value => !value)} hiddenFrom="sm" size="sm" aria-label={t("menu")} />
      <Link href="/" className="models-brand"><Group gap="xs" wrap="nowrap"><Image src="/logo.png" alt="" w={28} h={28} /><Text fw={650}>Agent Models</Text></Group></Link>
    </Group><Group gap={4} wrap="nowrap">
      <ActionIcon variant="subtle" aria-label={t("language")} onClick={() => { document.cookie = `agent-models-locale=${language === "en" ? "ko" : "en"}; Path=/; Max-Age=31536000; SameSite=Lax`; router.refresh(); }}><IconLanguage size={19} /></ActionIcon>
      <ActionIcon variant="subtle" aria-label={t("theme")} onClick={() => toggleColorScheme()}><IconSunMoon size={19} /></ActionIcon>
      <Menu position="bottom-end" width={260}><Menu.Target><UnstyledButton aria-label={t("profile")}><Avatar src={user.image ?? null} size={32} radius="xl">{user.name?.slice(0, 1) ?? "A"}</Avatar></UnstyledButton></Menu.Target>
        <Menu.Dropdown><Menu.Label><Text size="sm" fw={600}>{user.name}</Text><Text size="xs" className="models-wrap">{user.email}</Text></Menu.Label>
          <Menu.Item component={Link} href="/profile" leftSection={<IconUser size={16} />}>{t("profile")}</Menu.Item>
          <Menu.Item component="a" href={`${studioUrl}/profile`} target="_blank" rel="noreferrer">Agent Studio</Menu.Item><Menu.Divider />
          <Menu.Item leftSection={<IconLogout size={16} />} onClick={() => { void authClient.signOut().then(result => { if (result.error) setError(true); else window.location.assign("/login"); }).catch(() => setError(true)); }}>{t("signOut")}</Menu.Item>
        </Menu.Dropdown></Menu>
    </Group></Group></AppShell.Header>
    <AppShell.Navbar p="sm" visibleFrom="sm"><Stack justify="space-between" h="100%">{navigation}<Text size="xs" c="dimmed" px="sm">© OpsPresso</Text></Stack></AppShell.Navbar>
    <AppShell.Main><div className="models-container">{error && <Alert color="red">{t("failed")}</Alert>}{children}</div></AppShell.Main>
  </AppShell><Drawer opened={opened && !desktop} onClose={() => setOpened(false)} title="Agent Models" size={280}>{navigation}</Drawer></UserContext.Provider>;
}

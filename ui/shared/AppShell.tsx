import { useDocumentTheme } from '@modelcontextprotocol/ext-apps/react';
import React, { useEffect, useState, type CSSProperties, type ReactNode } from 'react';
import { notifyHostAboutResize } from './resize.js';
import { styles } from './styles.js';

const THEME_PALETTES = {
  light: {
    '--app-fg': '#0d0d0d',
    '--app-fg-muted': 'rgba(13, 13, 13, 0.65)',
    '--app-surface': 'rgba(0, 0, 0, 0.04)',
    '--app-surface-2': 'rgba(0, 0, 0, 0.08)',
    '--app-border': 'rgba(0, 0, 0, 0.15)',
    '--app-accent': '#2563eb',
  },
  dark: {
    '--app-fg': '#ececf1',
    '--app-fg-muted': 'rgba(236, 236, 241, 0.65)',
    '--app-surface': 'rgba(255, 255, 255, 0.08)',
    '--app-surface-2': 'rgba(255, 255, 255, 0.12)',
    '--app-border': 'rgba(255, 255, 255, 0.18)',
    '--app-accent': '#60a5fa',
  },
} as const;

type AppShellProps = {
  title: string;
  children: ReactNode;
};

export function AppShell({ title, children }: AppShellProps) {
  const theme = useDocumentTheme();
  const [collapsed, setCollapsed] = useState(false);
  const palette = THEME_PALETTES[theme] ?? THEME_PALETTES.light;

  useEffect(() => {
    notifyHostAboutResize();
  }, [collapsed]);

  const shellStyle: CSSProperties = {
    ...styles.appShell,
    ...(palette as unknown as CSSProperties),
    colorScheme: theme,
    color: 'var(--color-text-primary, var(--app-fg, inherit))',
  };

  return (
    <div style={shellStyle}>
      <div style={styles.appShellHeader}>
        <span style={styles.appShellTitle}>{title}</span>
        <button
          type="button"
          style={styles.appShellToggle}
          onClick={() => setCollapsed((prev) => !prev)}
          aria-expanded={!collapsed}
          aria-label={collapsed ? 'Expand' : 'Collapse'}
        >
          {collapsed ? '▸' : '▾'}
        </button>
      </div>
      {!collapsed && <div style={styles.appShellBody}>{children}</div>}
    </div>
  );
}

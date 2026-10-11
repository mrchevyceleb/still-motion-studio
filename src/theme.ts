import { useSyncExternalStore } from 'react';
import './desktop';

export type Theme = 'light' | 'dark';
const key = 'still.theme';
const system = window.matchMedia('(prefers-color-scheme: dark)');
const listeners = new Set<() => void>();
const readPreference = (): Theme | null => {
  try {
    const value = localStorage.getItem(key);
    return value === 'light' || value === 'dark' ? value : null;
  } catch { return null; }
};
let preference = readPreference();
let theme: Theme = preference ?? (system.matches ? 'dark' : 'light');

function applyTheme() {
  theme = preference ?? (system.matches ? 'dark' : 'light');
  document.documentElement.dataset.theme = theme;
  document.documentElement.style.colorScheme = theme;
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', theme === 'dark' ? '#141d19' : '#f4f3ee');
  window.stillDesktop?.setTheme(theme);
  listeners.forEach(listener => listener());
}

export function initializeTheme() {
  applyTheme();
  system.addEventListener('change', applyTheme);
  window.addEventListener('storage', event => {
    if (event.key === key || event.key === null) { preference = readPreference(); applyTheme(); }
  });
}

function toggleTheme() {
  preference = theme === 'dark' ? 'light' : 'dark';
  try { localStorage.setItem(key, preference); } catch { /* Keep the choice for this session if storage is unavailable. */ }
  applyTheme();
}

export function useTheme() {
  const current = useSyncExternalStore(callback => {
    listeners.add(callback);
    return () => { listeners.delete(callback); };
  }, () => theme);
  return { theme: current, toggleTheme };
}

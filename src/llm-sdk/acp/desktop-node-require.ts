import { Platform } from 'obsidian';

type DesktopNodeRequire = (moduleId: string) => unknown;

/**
 * Loads a Node module through Obsidian's Electron renderer bridge.
 *
 * Dynamic ESM imports such as `import('node:module')` are not resolved by
 * Obsidian's renderer, even in the desktop application. The renderer exposes
 * its CommonJS loader on the active window, which supports CLI-backed ACP
 * agents without putting a Node import in the browser bundle.
 */
export function requireDesktopNodeModule<T>(moduleId: string): T {
  if (!Platform.isDesktop) {
    throw new Error('Local ACP CLI agents are only supported on Obsidian desktop');
  }

  const runtimeWindow: unknown = typeof activeWindow !== 'undefined'
    ? activeWindow
    : typeof window !== 'undefined'
      ? window
      : undefined;
  const runtimeRequire = typeof runtimeWindow === 'object' && runtimeWindow !== null
    ? (runtimeWindow as { require?: unknown }).require
    : undefined;
  if (typeof runtimeRequire !== 'function') {
    throw new Error('Obsidian desktop Node integration is unavailable; local ACP CLI agents cannot be started');
  }

  return (runtimeRequire as DesktopNodeRequire)(moduleId) as T;
}

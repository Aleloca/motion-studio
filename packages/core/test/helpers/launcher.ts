import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { workspaceSettingsSchema, type WorkspaceSettings } from '@motion-studio/shared';
import { AgentLauncher, type LauncherDeps } from '../../src/agent/launcher.ts';
import type { AgentRunner } from '../../src/agent/runner.ts';
import { ApprovalBroker } from '../../src/approvals/broker.ts';
import { AgentBridge } from '../../src/bridge/bridge.ts';

/** Phase 3-equivalent launcher: no sandbox, no MCP (tests keep driving the fake claude exactly as before). */
export function testLauncher(runner: AgentRunner, over: Partial<Omit<LauncherDeps, 'settings'>> & { settings?: Partial<WorkspaceSettings> } = {}) {
  const settings = workspaceSettingsSchema.parse({ schemaVersion: 1, ...over.settings });
  return new AgentLauncher({
    runner, bridge: new AgentBridge(), approvals: new ApprovalBroker({ broadcast: () => {} }),
    sandbox: async () => ({ available: false, reason: 'test' }), configDir: mkdtempSync(join(tmpdir(), 'ms-cfg-')), mcpCommand: null,
    ...over, settings: async () => settings,
  });
}

// PhantomDock popup: pairing, guard/timing controls, adapter editor,
// skills + MCP health — all through the background context (never localhost).

import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  DEFAULT_SETTINGS,
  type BgRequest,
  type GuardSettings,
  type HandshakeInfo,
  type SkillSummary,
  type TabBinding,
  type ToolInfo,
} from '../shared/protocol';
import { validateAdapter, type AdapterDef } from '../adapters/schema';

function send<T>(msg: BgRequest): Promise<T> {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage(msg, (resp: T) => resolve(resp));
  });
}

export default function App(): JSX.Element {
  const [tabId, setTabId] = useState<number | null>(null);
  const [tabHost, setTabHost] = useState('');
  const [binding, setBinding] = useState<TabBinding | null>(null);
  const [daemon, setDaemon] = useState<HandshakeInfo | null>(null);
  const [tools, setTools] = useState<ToolInfo[]>([]);
  const [skills, setSkills] = useState<SkillSummary[]>([]);
  const [connected, setConnected] = useState(false);
  const [daemons, setDaemons] = useState<HandshakeInfo[]>([]);
  const [scanning, setScanning] = useState(false);
  const [selectedPort, setSelectedPort] = useState<number | null>(null);
  const [token, setToken] = useState('');
  const [pairError, setPairError] = useState('');
  const [settings, setSettings] = useState<GuardSettings>(DEFAULT_SETTINGS);

  useEffect(() => {
    void (async () => {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (tab?.id !== undefined) {
        setTabId(tab.id);
        try {
          setTabHost(new URL(tab.url ?? '').hostname);
        } catch {
          setTabHost('');
        }
      }
    })();
  }, []);

  const refreshStatus = useCallback(async () => {
    if (tabId === null) return;
    const res = await send<{
      ok: boolean;
      binding: TabBinding | null;
      daemonInfo: HandshakeInfo | null;
      tools: ToolInfo[];
      skills: SkillSummary[];
      connected: boolean;
    }>({ t: 'getStatus', tabId });
    if (res.ok) {
      setBinding(res.binding);
      setDaemon(res.daemonInfo);
      setTools(res.tools ?? []);
      setSkills(res.skills ?? []);
      setConnected(res.connected);
    }
  }, [tabId]);

  const scan = useCallback(async () => {
    setScanning(true);
    setPairError('');
    const res = await send<{ ok: boolean; daemons: HandshakeInfo[] }>({ t: 'scan' });
    if (res.ok) {
      setDaemons(res.daemons);
      if (res.daemons.length && selectedPort === null) {
        setSelectedPort(res.daemons[0].port);
      }
    }
    setScanning(false);
  }, [selectedPort]);

  useEffect(() => {
    void scan();
  }, [scan]);

  useEffect(() => {
    void refreshStatus();
    const t = setInterval(() => void refreshStatus(), 2500);
    return () => clearInterval(t);
  }, [refreshStatus]);

  const pair = useCallback(async () => {
    if (tabId === null || selectedPort === null || !token.trim()) {
      setPairError('Pick a daemon and paste the pairing token printed by pdock.');
      return;
    }
    setPairError('');
    const res = await send<{ ok: boolean; error?: string }>({
      t: 'bind',
      tabId,
      port: selectedPort,
      token: token.trim(),
    });
    if (res.ok) {
      setToken('');
      await refreshStatus();
    } else {
      setPairError(res.error ?? 'pairing failed');
    }
  }, [tabId, selectedPort, token, refreshStatus]);

  const unbind = useCallback(async () => {
    if (tabId === null) return;
    await send({ t: 'unbind', tabId });
    await refreshStatus();
  }, [tabId, refreshStatus]);

  const patch = useCallback(
    async (p: Partial<GuardSettings>) => {
      const next = { ...settings, ...p };
      setSettings(next);
      await send({ t: 'setSettings', patch: p });
    },
    [settings],
  );

  const bound = binding !== null && connected;

  return (
    <>
      <header>
        <div className="logo" />
        <h1>PhantomDock</h1>
        <span
          className={`dot ${bound ? 'on' : binding ? 'off' : ''}`}
          title={bound ? 'connected' : 'not connected'}
        />
      </header>

      <ConnectionPanel
        bound={bound}
        binding={binding}
        daemon={daemon}
        daemons={daemons}
        scanning={scanning}
        selectedPort={selectedPort}
        token={token}
        pairError={pairError}
        tabHost={tabHost}
        onSelectPort={setSelectedPort}
        onToken={setToken}
        onScan={() => void scan()}
        onPair={() => void pair()}
        onUnbind={() => void unbind()}
      />

      {bound ? (
        <>
          <DaemonPanel daemon={daemon} tools={tools} skills={skills} tabId={tabId} />
          <GuardsPanel settings={settings} onPatch={(p) => void patch(p)} />
          <AdapterPanel />
        </>
      ) : (
        <section>
          <h2>Not paired</h2>
          <p className="dim small">
            Run <span className="mono">pdock</span> in your project, pick the workspace above, and
            paste the one-time pairing token. Bind a web-AI tab to unlock workspace tools, skills,
            and MCP.
          </p>
        </section>
      )}

      <footer>
        <span>PhantomDock v0.1.0 · protocol v2</span>
        <span>{tabHost || ''}</span>
      </footer>
    </>
  );
}

// ---------------------------------------------------------------------------

function ConnectionPanel(props: {
  bound: boolean;
  binding: TabBinding | null;
  daemon: HandshakeInfo | null;
  daemons: HandshakeInfo[];
  scanning: boolean;
  selectedPort: number | null;
  token: string;
  pairError: string;
  tabHost: string;
  onSelectPort: (p: number) => void;
  onToken: (t: string) => void;
  onScan: () => void;
  onPair: () => void;
  onUnbind: () => void;
}): JSX.Element {
  const { bound, binding, daemon } = props;
  return (
    <section>
      <h2>Connection</h2>
      {bound ? (
        <>
          <div className="row">
            <span className="badge ok">BOUND</span>
            <span className="mono small">127.0.0.1:{binding?.port}</span>
            <div className="grow" />
            <button onClick={props.onUnbind}>Unbind</button>
          </div>
          <div className="dim small mono">{daemon?.cwd}</div>
          <div className="dim small">
            shell {daemon?.shell_enabled ? 'enabled' : 'disabled'} · pid {daemon?.pid} · v
            {daemon?.server_version}
          </div>
        </>
      ) : (
        <>
          <div className="row">
            <span className="dim small">
              Daemons on 127.0.0.1:47800-47820 {props.tabHost ? `· tab: ${props.tabHost}` : ''}
            </span>
            <div className="grow" />
            <button onClick={props.onScan} disabled={props.scanning}>
              {props.scanning ? 'Scanning…' : 'Refresh'}
            </button>
          </div>
          {props.daemons.length === 0 && !props.scanning ? (
            <p className="dim small">
              No daemon found. Start one with <span className="mono">pdock</span> and refresh.
            </p>
          ) : null}
          {props.daemons.map((d) => (
            <div
              key={d.port}
              className={`daemon-option ${props.selectedPort === d.port ? 'selected' : ''}`}
              onClick={() => props.onSelectPort(d.port)}
            >
              <div className="grow">
                <div className="mono small">:{d.port}</div>
                <div className="dim small" style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>
                  {d.cwd}
                </div>
                <div className="dim small">
                  {d.skills_count} skills · {d.mcp_servers.length} mcp
                </div>
              </div>
              {props.binding?.port === d.port ? <span className="badge">bound</span> : null}
            </div>
          ))}
          <div className="row">
            <input
              type="password"
              placeholder="Pairing token (printed once by pdock)"
              value={props.token}
              onChange={(e) => props.onToken(e.target.value)}
            />
            <button className="primary" onClick={props.onPair} disabled={!props.selectedPort}>
              Pair &amp; Bind
            </button>
          </div>
          {props.pairError ? <div className="error-box">{props.pairError}</div> : null}
        </>
      )}
    </section>
  );
}

// ---------------------------------------------------------------------------

async function currentTabOrigin(): Promise<string> {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  try {
    const u = new URL(tab?.url ?? '');
    return `${u.origin}/*`;
  } catch {
    return 'https://*/*';
  }
}

function DaemonPanel(props: {
  daemon: HandshakeInfo | null;
  tools: ToolInfo[];
  skills: SkillSummary[];
  tabId: number | null;
}): JSX.Element {
  const { daemon, tools, skills } = props;
  const [attachMsg, setAttachMsg] = useState('');
  const [injectMsg, setInjectMsg] = useState('');
  const [injected, setInjected] = useState(false);

  const attachSkill = async (name: string): Promise<void> => {
    if (props.tabId === null) return;
    setAttachMsg('');
    const res = await send<{ ok: boolean; error?: string }>({
      t: 'attachSkill',
      tabId: props.tabId,
      name,
    });
    setAttachMsg(
      res.ok ? `Attaching ${name}-skill.md to the chat input…` : res.error ?? 'failed',
    );
  };

  const injectHere = async (): Promise<void> => {
    if (props.tabId === null) return;
    const origin = await currentTabOrigin();
    let granted = true;
    try {
      granted = await chrome.permissions.request({ origins: [origin] });
    } catch {
      granted = false;
    }
    if (!granted) {
      setInjectMsg('Host permission denied.');
      return;
    }
    const res = await send<{ ok: boolean; error?: string }>({
      t: 'injectHere',
      tabId: props.tabId,
    });
    setInjected(res.ok);
    setInjectMsg(
      res.ok ? 'Injected. Reload the tab to re-activate after updates.' : res.error ?? 'failed',
    );
  };

  const readonly = tools.filter((t) => t.readonly).length;
  return (
    <section>
      <h2>Workspace · Skills · MCP</h2>
      <div className="row">
        <span className="small">
          {tools.length} tools ({readonly} read-only · {tools.length - readonly} need approval)
        </span>
      </div>
      {daemon?.mcp_servers.length ? (
        <div style={{ marginTop: 6 }}>
          {daemon.mcp_servers.map((s) => (
            <div key={s.name} className="row">
              <span
                className={`badge ${s.status === 'Healthy' ? 'ok' : s.status === 'Failed' ? 'err' : 'warn'}`}
              >
                {s.status}
              </span>
              <span className="mono small">{s.name}</span>
              <span className="dim small">{s.tool_count} tools</span>
            </div>
          ))}
        </div>
      ) : (
        <div className="dim small" style={{ marginTop: 6 }}>
          No MCP servers configured (add mcp.json in the workspace).
        </div>
      )}
      <div style={{ marginTop: 8 }}>
        {skills.length === 0 ? (
          <div className="dim small">
            No skills discovered. Drop one into{' '}
            <span className="mono">.phantomdock/skills/&lt;name&gt;/SKILL.md</span>.
          </div>
        ) : (
          skills.map((s) => (
            <div key={s.name} className="skill-item">
              <div className="grow">
                <div className="mono small" style={{ fontWeight: 600 }}>
                  {s.name}
                </div>
                <div className="dim small">{s.description}</div>
              </div>
              <button onClick={() => void attachSkill(s.name)}>Attach</button>
            </div>
          ))
        )}
      </div>
      {attachMsg ? <div className="dim small">{attachMsg}</div> : null}
      {!injected ? (
        <div className="row" style={{ marginTop: 8 }}>
          <button onClick={() => void injectHere()}>Enable PhantomDock on this site</button>
          <span className="dim small">for sites without a bundled adapter</span>
        </div>
      ) : null}
      {injectMsg ? <div className="dim small">{injectMsg}</div> : null}
    </section>
  );
}

// ---------------------------------------------------------------------------

function NumberField(props: {
  label: string;
  value: number;
  min?: number;
  onChange: (v: number) => void;
}): JSX.Element {
  return (
    <label className="small">
      <div className="dim">{props.label}</div>
      <input
        type="number"
        value={props.value}
        min={props.min ?? 0}
        onChange={(e) => props.onChange(Number(e.target.value) || 0)}
      />
    </label>
  );
}

function GuardsPanel(props: {
  settings: GuardSettings;
  onPatch: (p: Partial<GuardSettings>) => void;
}): JSX.Element {
  const s = props.settings;
  return (
    <section>
      <h2>Guards &amp; Timing</h2>
      <div className="grid2">
        <NumberField
          label="Submit delay min (ms)"
          value={s.submitDelayRangeMs[0]}
          onChange={(v) => props.onPatch({ submitDelayRangeMs: [v, s.submitDelayRangeMs[1]] })}
        />
        <NumberField
          label="Submit delay max (ms)"
          value={s.submitDelayRangeMs[1]}
          onChange={(v) => props.onPatch({ submitDelayRangeMs: [s.submitDelayRangeMs[0], v] })}
        />
        <NumberField
          label="Inter-turn min (ms)"
          value={s.interTurnDelayRangeMs[0]}
          onChange={(v) =>
            props.onPatch({ interTurnDelayRangeMs: [v, s.interTurnDelayRangeMs[1]] })
          }
        />
        <NumberField
          label="Inter-turn max (ms)"
          value={s.interTurnDelayRangeMs[1]}
          onChange={(v) =>
            props.onPatch({ interTurnDelayRangeMs: [s.interTurnDelayRangeMs[0], v] })
          }
        />
        <NumberField
          label="Cooldown (s)"
          value={s.cooldownSeconds}
          onChange={(v) => props.onPatch({ cooldownSeconds: v })}
        />
        <NumberField
          label="Max cooldown (s)"
          value={s.maxCooldownSeconds}
          onChange={(v) => props.onPatch({ maxCooldownSeconds: v })}
        />
        <NumberField
          label="Max consecutive turns"
          value={s.maxConsecutiveAutoTurns}
          onChange={(v) => props.onPatch({ maxConsecutiveAutoTurns: v })}
        />
        <NumberField
          label="Max turns / hour"
          value={s.maxAutomatedTurnsPerHour}
          onChange={(v) => props.onPatch({ maxAutomatedTurnsPerHour: v })}
        />
      </div>
      <label className="check small">
        <input
          type="checkbox"
          checked={s.requireVisibleTab}
          onChange={(e) => props.onPatch({ requireVisibleTab: e.target.checked })}
        />
        Active-tab gate (pause automation when the tab is hidden)
      </label>
      <label className="check small">
        <input
          type="checkbox"
          checked={s.autoApproveReadOnly}
          onChange={(e) => props.onPatch({ autoApproveReadOnly: e.target.checked })}
        />
        Auto-approve read-only tools (reads, skills)
      </label>
      <label className="check small">
        <input
          type="checkbox"
          checked={s.autoPrependFirstTurn}
          onChange={(e) => props.onPatch({ autoPrependFirstTurn: e.target.checked })}
        />
        Auto-prepend workspace manifest on the first turn
      </label>
      <label className="check small">
        <input
          type="checkbox"
          checked={s.autoSendAllParts}
          onChange={(e) => props.onPatch({ autoSendAllParts: e.target.checked })}
        />
        Auto-send all inline skill parts sequentially
      </label>
    </section>
  );
}

// ---------------------------------------------------------------------------

function AdapterPanel(): JSX.Element {
  const [adapters, setAdapters] = useState<Record<string, AdapterDef>>({});
  const [bundled, setBundled] = useState<string[]>([]);
  const [selectedId, setSelectedId] = useState('');
  const [draft, setDraft] = useState('');
  const [error, setError] = useState('');
  const [saved, setSaved] = useState(false);

  const load = useCallback(async () => {
    const res = await send<{
      ok: boolean;
      adapters: Record<string, unknown>;
      bundled: string[];
    }>({ t: 'getAdapters' });
    if (res.ok) {
      const validated: Record<string, AdapterDef> = {};
      for (const [id, v] of Object.entries(res.adapters)) {
        const r = validateAdapter(v);
        if (r.ok) validated[id] = r.def;
      }
      setAdapters(validated);
      setBundled(res.bundled);
      setSelectedId((cur) => cur || Object.keys(validated)[0] || '');
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    if (selectedId && adapters[selectedId]) {
      setDraft(JSON.stringify(adapters[selectedId], null, 2));
      setError('');
      setSaved(false);
    }
  }, [selectedId, adapters]);

  const current = adapters[selectedId];
  const isModified = useMemo(
    () => current !== undefined && draft !== JSON.stringify(current, null, 2),
    [draft, current],
  );

  const save = async (): Promise<void> => {
    setError('');
    setSaved(false);
    let parsed: unknown;
    try {
      parsed = JSON.parse(draft);
    } catch (e) {
      setError(`Invalid JSON: ${e instanceof Error ? e.message : String(e)}`);
      return;
    }
    const res = await send<{ ok: boolean; error?: string }>({ t: 'saveAdapter', def: parsed });
    if (res.ok) {
      setSaved(true);
      await load();
    } else {
      setError(res.error ?? 'validation failed');
    }
  };

  const duplicate = async (): Promise<void> => {
    if (!current) return;
    const copy = { ...current, id: `${current.id}-copy`, name: `${current.name} (copy)` };
    const res = await send<{ ok: boolean; error?: string }>({ t: 'saveAdapter', def: copy });
    if (res.ok) {
      setSelectedId(copy.id);
      await load();
    }
  };

  const reset = async (): Promise<void> => {
    if (!bundled.includes(selectedId)) return;
    await send({ t: 'resetAdapter', id: selectedId });
    await load();
  };

  const exportJson = (): void => {
    const blob = new Blob([draft], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${selectedId || 'adapter'}.json`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const importJson = (file: File): void => {
    const reader = new FileReader();
    reader.onload = () => {
      setDraft(String(reader.result ?? ''));
    };
    reader.readAsText(file);
  };

  return (
    <section>
      <h2>Site Adapters (v2)</h2>
      <div className="row">
        <select value={selectedId} onChange={(e) => setSelectedId(e.target.value)}>
          {Object.values(adapters).map((a) => (
            <option key={a.id} value={a.id}>
              {a.name}
              {bundled.includes(a.id) ? ' (bundled)' : ''}
            </option>
          ))}
        </select>
        <button onClick={() => void duplicate()}>Duplicate</button>
        {bundled.includes(selectedId) ? <button onClick={() => void reset()}>Reset</button> : null}
      </div>
      <textarea value={draft} onChange={(e) => setDraft(e.target.value)} spellCheck={false} />
      <div className="row">
        <button className="primary" onClick={() => void save()} disabled={!isModified}>
          Save &amp; hot-reload
        </button>
        <button onClick={exportJson}>Export</button>
        <label className="small" style={{ cursor: 'pointer' }}>
          Import…{' '}
          <input
            type="file"
            accept="application/json"
            style={{ display: 'none' }}
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) importJson(f);
            }}
          />
        </label>
        {saved ? <span className="badge ok">saved</span> : null}
      </div>
      {error ? <div className="error-box mono small">{error}</div> : null}
      <p className="dim small">
        Selectors are live-verified against the site on the next turn. Bundled presets: qwen-chat,
        deepseek-chat, chatgpt, universal-fallback.
      </p>
    </section>
  );
}

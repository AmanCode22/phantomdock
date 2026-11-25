// PhantomDock popup: pairing, guard/timing controls, adapter editor,
// skills + MCP health + live DOM diagnostics — all through background context.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  DEFAULT_SETTINGS,
  type BgRequest,
  type BgStatusResponse,
  type DiagnosticReport,
  type GuardSettings,
  type HandshakeInfo,
  type SkillSummary,
  type TabBinding,
  type ToolInfo,
} from '../shared/protocol';
import { validateAdapter, type AdapterDef } from '../adapters/schema';

function send<T>(msg: BgRequest): Promise<T | undefined> {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage(msg, (resp: T) => {
      const error = chrome.runtime.lastError;
      resolve(error ? undefined : resp);
    });
  });
}

type PopupTab = 'main' | 'guards' | 'adapters';

export default function App(): JSX.Element {
  const [tabId, setTabId] = useState<number | null>(null);
  const [tabHost, setTabHost] = useState('');
  const [activeTab, setActiveTab] = useState<PopupTab>('main');
  const [binding, setBinding] = useState<TabBinding | null>(null);
  const [daemon, setDaemon] = useState<HandshakeInfo | null>(null);
  const [tools, setTools] = useState<ToolInfo[]>([]);
  const [skills, setSkills] = useState<SkillSummary[]>([]);
  const [connected, setConnected] = useState(false);
  const [contentActive, setContentActive] = useState(false);
  const [stopped, setStopped] = useState(false);
  const [stopPending, setStopPending] = useState(false);
  const [workspaceMessage, setWorkspaceMessage] = useState('');
  const [copyMessage, setCopyMessage] = useState('');
  const statusRequest = useRef(0);
  const [daemons, setDaemons] = useState<HandshakeInfo[]>([]);
  const [scanning, setScanning] = useState(false);
  const [statusLoaded, setStatusLoaded] = useState(false);
  const [selectedPort, setSelectedPort] = useState<number | null>(null);
  const [token, setToken] = useState('');
  const [pairError, setPairError] = useState('');
  const [pairing, setPairing] = useState(false);
  const [settings, setSettings] = useState<GuardSettings>(DEFAULT_SETTINGS);
  const [diag, setDiag] = useState<DiagnosticReport | null>(null);
  const [diagError, setDiagError] = useState('');
  const [injectMsg, setInjectMsg] = useState('');
  const selectedPortRef = useRef<number | null>(null);
  selectedPortRef.current = selectedPort;

  useEffect(() => {
    void (async () => {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (tab?.id === undefined) setStatusLoaded(true);
      if (tab?.id !== undefined) {
        setTabId(tab.id);
        try {
          setTabHost(new URL(tab.url ?? '').hostname);
        } catch {
          setTabHost('');
        }
      }
      const sRes = await send<{ ok: boolean; settings: GuardSettings }>({ t: 'getSettings' });
      if (sRes?.ok && sRes.settings) {
        setSettings(sRes.settings);
      }
    })();
  }, []);

  const refreshStatus = useCallback(async () => {
    if (tabId === null) return;
    const request = ++statusRequest.current;
    const res = await send<BgStatusResponse>({ t: 'getStatus', tabId });
    if (request !== statusRequest.current) return;
    if (res?.ok) {
      setBinding(res.binding);
      setDaemon(res.daemonInfo);
      setTools(res.tools ?? []);
      setSkills(res.skills ?? []);
      setConnected(res.connected);
      setContentActive(Boolean(res.contentActive));
      setStopped(Boolean(res.stopped));
    }
    setStatusLoaded(true);
  }, [tabId]);

  const scan = useCallback(async () => {
    setScanning(true);
    setPairError('');
    const res = await send<{ ok: boolean; daemons: HandshakeInfo[] }>({ t: 'scan' });
    if (res?.ok) {
      setDaemons(res.daemons);
      if (!res.daemons.some((daemon) => daemon.port === selectedPortRef.current)) {
        setSelectedPort(res.daemons[0]?.port ?? null);
      }
    }
    setScanning(false);
  }, []);

  const hasBinding = binding !== null;
  useEffect(() => {
    if (statusLoaded && !hasBinding) void scan();
  }, [statusLoaded, hasBinding, scan]);

  useEffect(() => {
    void refreshStatus();
    if (activeTab !== 'main') return;
    let timer: ReturnType<typeof setTimeout>;
    let cancelled = false;
    const poll = async (): Promise<void> => {
      await refreshStatus();
      if (!cancelled) timer = setTimeout(() => void poll(), 3000);
    };
    timer = setTimeout(() => void poll(), 3000);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [activeTab, refreshStatus]);

  const pair = useCallback(async () => {
    if (tabId === null || selectedPort === null || !token.trim()) {
      setPairError('Pick a daemon and paste the pairing token printed by pdock.');
      return;
    }
    setPairing(true);
    setPairError('');
    const res = await send<{ ok: boolean; error?: string }>({
      t: 'bind',
      tabId,
      port: selectedPort,
      token: token.trim(),
    });
    setPairing(false);
    if (res?.ok) {
      setToken('');
      await refreshStatus();
    } else {
      setPairError(res?.error ?? 'pairing failed');
    }
  }, [tabId, selectedPort, token, refreshStatus]);

  const reconnect = useCallback(async () => {
    if (tabId === null) return;
    setPairError('');
    const res = await send<{ ok: boolean; error?: string }>({ t: 'reconnect', tabId });
    if (res?.ok) {
      await refreshStatus();
    } else {
      setPairError(res?.error ?? 'reconnect failed');
    }
  }, [tabId, refreshStatus]);

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

  const runDiagnostics = useCallback(async () => {
    if (tabId === null) return;
    setDiagError('');
    setCopyMessage('');
    const res = await send<{ ok: boolean; report?: DiagnosticReport; error?: string }>({
      t: 'diagnoseTab',
      tabId,
    });
    if (res?.ok && res.report) {
      setDiag(res.report);
    } else {
      setDiag(null);
      setDiagError(res?.error ?? 'Diagnostics unavailable on this tab.');
    }
  }, [tabId]);

  const injectHere = useCallback(async () => {
    if (tabId === null) return;
    setInjectMsg('');
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
      tabId,
    });
    setInjectMsg(
      res?.ok ? 'Content script injected into this tab.' : res?.error ?? 'Injection failed',
    );
    await refreshStatus();
  }, [tabId, refreshStatus]);

  const toggleStop = async (): Promise<void> => {
    if (tabId === null || stopPending) return;
    setStopPending(true);
    setWorkspaceMessage('');
    const res = await send<{ ok: boolean; error?: string }>({ t: 'stopAutomation', tabId, stopped: !stopped });
    if (res?.ok) {
      await refreshStatus();
    } else {
      setWorkspaceMessage(res?.error ?? 'Could not update this tab’s automation.');
    }
    setStopPending(false);
  };

  const attachWorkspace = async (): Promise<void> => {
    if (tabId === null) return;
    const res = await send<{ ok: boolean; error?: string }>({ t: 'attachWorkspace', tabId });
    setWorkspaceMessage(res?.ok ? 'Check your chat draft for workspace context.' : res?.error ?? 'Could not reach the chat tab.');
  };

  const copyDiagnostics = async (): Promise<void> => {
    if (!diag) return;
    try {
      await navigator.clipboard.writeText(JSON.stringify(diag, null, 2));
      setCopyMessage('Copied.');
    } catch {
      setCopyMessage('Clipboard unavailable.');
    }
  };

  const bound = binding !== null && connected;
  const connectionLabel = !statusLoaded ? 'Checking…' : bound ? 'Connected' : binding ? 'Disconnected' : 'Not paired';

  return (
    <>
      <div className="popup-top">
        <header>
          <img className="logo" src="./icons/icon48.png" alt="" />
          <div className="grow">
            <h1>PhantomDock</h1>
            <div className="dim small header-host">{tabHost || 'Local workspace'}</div>
          </div>
          <span className={`connection-status ${bound ? 'online' : binding ? 'offline' : ''}`} role="status">
            {connectionLabel}
          </span>
        </header>

        <nav className="tabs" aria-label="Popup sections">
          <button
            className={activeTab === 'main' ? 'active' : ''}
            aria-pressed={activeTab === 'main'}
            onClick={() => setActiveTab('main')}
          >
            Workspace
          </button>
          <button
            className={activeTab === 'guards' ? 'active' : ''}
            aria-pressed={activeTab === 'guards'}
            onClick={() => setActiveTab('guards')}
          >
            Automation
          </button>
          <button
            className={activeTab === 'adapters' ? 'active' : ''}
            aria-pressed={activeTab === 'adapters'}
            onClick={() => setActiveTab('adapters')}
          >
            Adapters
          </button>
        </nav>
      </div>

      {activeTab === 'main' ? (
        <>
          {statusLoaded ? (
            <ConnectionPanel
              bound={bound}
              binding={binding}
              daemon={daemon}
              daemons={daemons}
              scanning={scanning}
              pairing={pairing}
              selectedPort={selectedPort}
              token={token}
              pairError={pairError}
              onSelectPort={setSelectedPort}
              onToken={setToken}
              onScan={() => void scan()}
              onPair={() => void pair()}
              onReconnect={() => void reconnect()}
              onUnbind={() => void unbind()}
            />
          ) : <section role="status">Checking this tab’s workspace…</section>}

          {binding && contentActive ? (
            <section className="workspace-actions" aria-label="Chat controls">
              <div className="row">
                <button className="primary" disabled={!bound} onClick={() => void attachWorkspace()}>
                  Insert workspace context
                </button>
                <button className={stopped ? '' : 'danger'} disabled={stopPending} onClick={() => void toggleStop()}>
                  {stopped ? 'Resume automation' : 'Stop automation'}
                </button>
              </div>
              {workspaceMessage ? <p className="dim small" role="status">{workspaceMessage}</p> : null}
            </section>
          ) : null}

          {bound ? (
            <DaemonPanel daemon={daemon} tools={tools} skills={skills} tabId={tabId} />
          ) : null}

          <details className="diagnostics">
            <summary>Chat tab diagnostics</summary>
            <div className="row">
              <span className={`badge ${contentActive ? 'ok' : 'warn'}`}>
                {contentActive ? 'ACTIVE' : 'INACTIVE'}
              </span>
              <span className="dim small">{tabHost || 'unsupported tab'}</span>
              <div className="grow" />
              {!contentActive ? (
                <button onClick={() => void injectHere()}>Enable on site</button>
              ) : null}
              <button onClick={() => void runDiagnostics()} disabled={!contentActive}>
                Test Selectors
              </button>
            </div>
            {injectMsg ? <div className="dim small">{injectMsg}</div> : null}
            {diagError ? <div className="error-box small">{diagError}</div> : null}
            {diag ? (
              <div className="diag-grid small mono">
                <div>Adapter: {diag.adapterName}</div>
                <div>Input: {diag.inputFound ? '✓ found' : '✗ missing'}</div>
                <div>Send btn: {diag.sendButtonFound ? '✓ found' : '✗ missing'}</div>
                <div>
                  Msgs: {diag.assistantCount} asst · {diag.userCount} user
                </div>
                <div>Streaming: {diag.streaming ? 'yes' : 'no'}</div>
                <div>
                  Banners: {diag.challengeVisible ? 'CAPTCHA ' : ''}
                  {diag.rateLimitVisible ? 'RATE-LIMIT' : ''}
                  {!diag.challengeVisible && !diag.rateLimitVisible ? 'none' : ''}
                </div>
              </div>
            ) : null}
            {diag ? (
              <div className="row">
                <button onClick={() => void copyDiagnostics()}>Copy report</button>
                <span className="dim small" role="status">{copyMessage}</span>
              </div>
            ) : null}
          </details>
        </>
      ) : null}

      {activeTab === 'guards' ? (
        <GuardsPanel settings={settings} onPatch={(p) => void patch(p)} />
      ) : null}

      {activeTab === 'adapters' ? <AdapterPanel /> : null}

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
  pairing: boolean;
  selectedPort: number | null;
  token: string;
  pairError: string;
  onSelectPort: (p: number) => void;
  onToken: (t: string) => void;
  onScan: () => void;
  onPair: () => void;
  onReconnect: () => void;
  onUnbind: () => void;
}): JSX.Element {
  const { bound, binding, daemon } = props;
  const workspaceName = daemon?.cwd.split(/[\\/]/).filter(Boolean).at(-1);
  return (
    <section className="connection">
      {bound ? (
        <>
          <div className="row connection-heading">
            <div className="grow">
              <h2>Local workspace</h2>
              <h3 title={daemon?.cwd}>{workspaceName || daemon?.cwd || 'Workspace'}</h3>
            </div>
            <button onClick={props.onUnbind}>Disconnect</button>
          </div>
          <div className="workspace-path mono" title={daemon?.cwd}>{daemon?.cwd}</div>
          <div className="connection-meta dim small">
            <span className="mono">127.0.0.1:{binding?.port}</span>
            <span>Shell {daemon?.shell_enabled ? 'enabled' : 'disabled'}</span>
          </div>
        </>
      ) : (
        <>
          <h2>Connect a workspace</h2>
          {binding ? (
            <div className="row">
              <span className="badge err">DISCONNECTED</span>
              <span className="mono small">:{binding.port}</span>
              <div className="grow" />
              <button className="primary" onClick={props.onReconnect}>
                Reconnect
              </button>
              <button onClick={props.onUnbind}>Unbind</button>
            </div>
          ) : null}
          <div className="row">
            <span className="dim small">Daemons on 127.0.0.1:47800–47820</span>
            <div className="grow" />
            <button onClick={props.onScan} disabled={props.scanning}>
              {props.scanning ? 'Scanning…' : 'Refresh'}
            </button>
          </div>
          {props.daemons.length === 0 && !props.scanning ? (
            <p className="dim small">
              Run <code>pdock</code> in your project folder, then refresh here.
            </p>
          ) : null}
          {props.daemons.map((d) => (
            <button
              type="button"
              aria-pressed={props.selectedPort === d.port}
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
            </button>
          ))}
          <form className="row pairing-form" onSubmit={(event) => { event.preventDefault(); props.onPair(); }}>
            <input
              aria-label="Pairing token"
              autoComplete="off"
              disabled={props.pairing}
              type="password"
              placeholder="Pairing token (printed once by pdock)"
              value={props.token}
              onChange={(e) => props.onToken(e.target.value)}
            />
            <button
              className="primary"
              type="submit"
              disabled={!props.selectedPort || !props.token.trim() || props.pairing}
            >
              {props.pairing ? 'Pairing…' : 'Pair & Bind'}
            </button>
          </form>
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
  const [query, setQuery] = useState('');
  const filter = query.trim().toLowerCase();
  const visibleSkills = skills.filter((skill) =>
    `${skill.name} ${skill.description}`.toLowerCase().includes(filter),
  );
  const visibleTools = tools.filter((tool) => tool.name.toLowerCase().includes(filter));

  const attachSkill = async (name: string): Promise<void> => {
    if (props.tabId === null) return;
    setAttachMsg('');
    const res = await send<{ ok: boolean; error?: string }>({
      t: 'attachSkill',
      tabId: props.tabId,
      name,
    });
    setAttachMsg(
      res?.ok ? `Attaching ${name}-skill.md to the chat input…` : res?.error ?? 'failed',
    );
  };

  const readonly = tools.filter((t) => t.readonly).length;
  return (
    <section>
      <h2>Workspace resources</h2>
      <input
        type="search"
        aria-label="Search skills and tools"
        placeholder="Search skills and tools…"
        value={query}
        onChange={(event) => setQuery(event.target.value)}
      />
      <div className="row">
        <span className="small">
          {tools.length} tools ({readonly} read-only · {tools.length - readonly} need approval)
        </span>
      </div>
      <details className="tool-list" open={filter ? true : undefined}>
        <summary>Tools ({visibleTools.length})</summary>
        {visibleTools.length ? (
          <ul>
            {visibleTools.map((tool) => (
              <li key={tool.name}>
                <span className="mono">{tool.name}</span>
                <span className="dim small">{tool.readonly ? 'Read-only' : 'Approval needed'}</span>
              </li>
            ))}
          </ul>
        ) : <p className="dim small">No matching tools.</p>}
      </details>
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
          visibleSkills.length ? visibleSkills.map((s) => (
            <div key={s.name} className="skill-item">
              <div className="grow">
                <div className="mono small" style={{ fontWeight: 600 }}>
                  {s.name}
                </div>
                <div className="dim small">{s.description}</div>
              </div>
              <button onClick={() => void attachSkill(s.name)}>Attach</button>
            </div>
          )) : <div className="dim small">No matching skills.</div>
        )}
      </div>
      {attachMsg ? <div className="dim small">{attachMsg}</div> : null}
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
          checked={s.challengeWatch}
          onChange={(e) => props.onPatch({ challengeWatch: e.target.checked })}
        />
        CAPTCHA / challenge circuit breaker
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
    if (res?.ok) {
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
    if (res?.ok) {
      setSaved(true);
      await load();
    } else {
      setError(res?.error ?? 'validation failed');
    }
  };

  const duplicate = async (): Promise<void> => {
    if (!current) return;
    const copy = { ...current, id: `${current.id}-copy`, name: `${current.name} (copy)` };
    const res = await send<{ ok: boolean; error?: string }>({ t: 'saveAdapter', def: copy });
    if (res?.ok) {
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
        Saving hot-reloads active tabs immediately. Bundled presets: qwen-chat, deepseek-chat,
        chatgpt, gemini, kimi, universal-fallback.
      </p>
    </section>
  );
}

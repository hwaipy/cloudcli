import WebSocket from 'ws';

const RECONNECT_BASE_MS = 1_000;
const RECONNECT_MAX_MS = 60_000;
const HANDSHAKE_TIMEOUT_MS = 5_000;

type BackendRegistrationSettings = {
  hubUrl: URL;
  key: string;
  id: string;
  name: string;
  backendUrl: URL;
};

function readBackendRegistrationSettings(): BackendRegistrationSettings | null {
  const hubUrlValue = process.env.CLOUDCLI_HUB_URL;
  const key = process.env.CLOUDCLI_HUB_REGISTRATION_KEY;
  const id = process.env.CLOUDCLI_BACKEND_ID;
  const name = process.env.CLOUDCLI_BACKEND_NAME;
  const backendUrlValue = process.env.CLOUDCLI_BACKEND_URL;
  const configured = [hubUrlValue, key, id, name, backendUrlValue].filter(Boolean).length;
  if (configured === 0) return null;
  if (configured !== 5) throw new Error('Hub self-registration requires CLOUDCLI_HUB_URL, CLOUDCLI_HUB_REGISTRATION_KEY, CLOUDCLI_BACKEND_ID, CLOUDCLI_BACKEND_NAME, and CLOUDCLI_BACKEND_URL');
  if (!/^[a-zA-Z0-9_-]{1,48}$/.test(id!)) throw new Error('CLOUDCLI_BACKEND_ID must contain 1-48 letters, numbers, underscores, or hyphens');
  if (!name!.trim() || name!.trim().length > 100) throw new Error('CLOUDCLI_BACKEND_NAME must contain 1-100 characters');
  if (Buffer.byteLength(key!) < 32) throw new Error('CLOUDCLI_HUB_REGISTRATION_KEY must contain at least 32 bytes');

  const hubUrl = new URL(hubUrlValue!);
  const backendUrl = new URL(backendUrlValue!);
  for (const [label, url] of [['CLOUDCLI_HUB_URL', hubUrl], ['CLOUDCLI_BACKEND_URL', backendUrl]] as const) {
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password
      || url.pathname !== '/' || url.search || url.hash) {
      throw new Error(`${label} must be an HTTP(S) origin without credentials or a path`);
    }
  }
  const protocol = hubUrl.protocol === 'https:' ? 'wss:' : 'ws:';
  hubUrl.protocol = protocol;
  hubUrl.pathname = '/hub/register/ws';
  hubUrl.searchParams.set('backend_id', id!);
  return { hubUrl, key: key!, id: id!, name: name!.trim(), backendUrl };
}

/** Used by the main backend process to maintain its outbound authenticated registration socket to Hub. */
export function startBackendRegistration(): () => void {
  let settings: BackendRegistrationSettings | null;
  try {
    settings = readBackendRegistrationSettings();
  } catch (error) {
    console.error(`[Hub registration] Configuration error: ${(error as Error).message}`);
    return () => undefined;
  }
  if (!settings) return () => undefined;

  let stopped = false;
  let socket: WebSocket | null = null;
  let reconnectTimer: NodeJS.Timeout | null = null;
  let retryDelay = RECONNECT_BASE_MS;
  let lastFailureLoggedAt = 0;

  const scheduleReconnect = () => {
    if (stopped || reconnectTimer) return;
    const delay = retryDelay;
    retryDelay = Math.min(retryDelay * 2, RECONNECT_MAX_MS);
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      connect();
    }, delay);
    reconnectTimer.unref();
  };

  const connect = () => {
    if (stopped) return;
    const nextSocket = new WebSocket(settings!.hubUrl, {
      headers: { Authorization: `Bearer ${settings!.key}` },
      handshakeTimeout: HANDSHAKE_TIMEOUT_MS,
      maxPayload: 8192,
    });
    socket = nextSocket;
    let confirmed = false;
    nextSocket.on('open', () => {
      nextSocket.send(JSON.stringify({
        id: settings!.id,
        name: settings!.name,
        url: settings!.backendUrl.origin,
      }));
    });
    nextSocket.on('message', (raw, isBinary) => {
      if (isBinary) { nextSocket.close(1008, 'Hub response must be text JSON'); return; }
      let response: { kind?: unknown; id?: unknown };
      try { response = JSON.parse(raw.toString()) as typeof response; } catch {
        nextSocket.close(1008, 'Invalid Hub response');
        return;
      }
      if (response.kind !== 'registered' || response.id !== settings!.id) {
        nextSocket.close(1008, 'Hub did not confirm this backend registration');
        return;
      }
      confirmed = true;
      retryDelay = RECONNECT_BASE_MS;
      console.info(`[Hub registration] Connected as backend "${settings!.id}"`);
    });
    nextSocket.on('error', (error) => {
      if (Date.now() - lastFailureLoggedAt >= 5 * 60_000) {
        console.warn(`[Hub registration] Connection error for "${settings!.id}": ${error.message}`);
        lastFailureLoggedAt = Date.now();
      }
    });
    nextSocket.on('close', () => {
      if (socket === nextSocket) socket = null;
      if (confirmed && !stopped) console.warn(`[Hub registration] Connection for "${settings!.id}" closed; reconnecting`);
      scheduleReconnect();
    });
  };

  connect();
  return () => {
    stopped = true;
    if (reconnectTimer) clearTimeout(reconnectTimer);
    reconnectTimer = null;
    const activeSocket = socket;
    socket = null;
    if (activeSocket && activeSocket.readyState < WebSocket.CLOSING) activeSocket.close(1000, 'Backend shutting down');
  };
}

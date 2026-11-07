import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createInterface } from 'node:readline';

import type { CodexProcessLaunch } from '@/shared/types.js';
import { resolveCodexLauncher } from '@/modules/providers/list/codex/codex-app-server.client.js';

type RpcMessage = {
  id?: string | number;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: { message?: string };
};

type PendingRequest = {
  resolve(value: unknown): void;
  reject(error: Error): void;
  timer: ReturnType<typeof setTimeout>;
};

/** Used only by the experimental Codex runtime to keep one subscribed App Server alive across turns. */
export class CodexAppServerConnection {
  private readonly child: ChildProcessWithoutNullStreams;
  private readonly pending = new Map<number, PendingRequest>();
  private readonly listeners = new Set<(message: RpcMessage) => void>();
  private readonly closeListeners = new Set<(error: Error) => void>();
  private requestHandler?: (id: string | number, method: string, params: unknown) => boolean;
  private nextId = 1;
  private closed = false;
  private readonly ready: Promise<void>;

  constructor(private readonly launch?: CodexProcessLaunch) {
    this.child = spawn(launch?.command ?? process.execPath, launch?.args ?? [resolveCodexLauncher(), 'app-server'], {
      env: process.env,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const reader = createInterface({ input: this.child.stdout });
    reader.on('line', (line) => this.receive(line));
    this.child.on('error', (error) => this.fail(error));
    this.child.on('exit', (code, signal) => this.fail(new Error(`Codex App Server exited (${code ?? signal ?? 'unknown'}).`)));
    this.child.stdin.on('error', (error) => this.fail(error));
    // App Server writes diagnostics to stderr; a pipe must be drained even
    // when there is nothing useful to show in the chat transcript.
    this.child.stderr.on('data', () => {});
    this.ready = this.request('initialize', {
      clientInfo: { name: 'cloudcli', title: 'CloudCLI', version: '1' },
      capabilities: { experimentalApi: true },
    }).then(() => {
      this.write({ jsonrpc: '2.0', method: 'initialized', params: {} });
    });
    void this.ready.catch(() => {});
  }

  private write(message: unknown): void {
    if (this.closed) throw new Error('Codex App Server is closed.');
    this.child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  private receive(line: string): void {
    let message: RpcMessage;
    try {
      message = JSON.parse(line) as RpcMessage;
    } catch {
      return;
    }
    if (typeof message.id === 'number' && !message.method) {
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      clearTimeout(pending.timer);
      if (message.error) pending.reject(new Error(message.error.message || 'Codex App Server request failed.'));
      else pending.resolve(message.result);
      return;
    }
    if ((typeof message.id === 'number' || typeof message.id === 'string') && message.method) {
      if (this.requestHandler?.(message.id, message.method, message.params)) return;
      // Permission requests fail closed until this transport has an approval UI.
      if (message.method === 'item/commandExecution/requestApproval'
        || message.method === 'item/fileChange/requestApproval'
        || message.method === 'execCommandApproval'
        || message.method === 'applyPatchApproval') {
        this.write({ jsonrpc: '2.0', id: message.id, result: { decision: 'decline' } });
      } else {
        this.write({ jsonrpc: '2.0', id: message.id, error: { code: -32601, message: 'CloudCLI does not support this App Server request.' } });
      }
      return;
    }
    if (message.method) {
      for (const listener of this.listeners) listener(message);
    }
  }

  /** Used by the runtime to handle supported server-to-client RPCs without treating them as notifications. */
  onRequest(handler: (id: string | number, method: string, params: unknown) => boolean): void {
    this.requestHandler = handler;
  }

  /** Used by the question bridge to answer the original server RPC, preserving numeric or string request IDs. */
  respond(id: string | number, result: unknown): void {
    this.write({ jsonrpc: '2.0', id, result });
  }

  private fail(error: Error): void {
    if (this.closed) return;
    this.closed = true;
    this.requestHandler = undefined;
    this.launch?.cleanup?.();
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
    for (const listener of this.closeListeners) listener(error);
    this.listeners.clear();
    this.closeListeners.clear();
  }

  private request(method: string, params: unknown): Promise<unknown> {
    return new Promise((resolve, reject) => {
      if (this.closed) return reject(new Error('Codex App Server is closed.'));
      const id = this.nextId++;
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Codex App Server did not answer ${method} within 30 seconds.`));
      }, 30_000);
      this.pending.set(id, { resolve, reject, timer });
      try {
        this.write({ jsonrpc: '2.0', id, method, params });
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(error);
      }
    });
  }

  async call(method: string, params: unknown): Promise<unknown> {
    await this.ready;
    const result = await this.request(method, params);
    if (method === 'thread/fork') await this.launch?.syncState?.();
    return result;
  }

  subscribe(listener: (message: RpcMessage) => void, onClose: (error: Error) => void): () => void {
    if (this.closed) {
      onClose(new Error('Codex App Server is closed.'));
      return () => {};
    }
    this.listeners.add(listener);
    this.closeListeners.add(onClose);
    return () => {
      this.listeners.delete(listener);
      this.closeListeners.delete(onClose);
    };
  }

  close(): void {
    if (this.closed) return;
    this.child.kill();
    this.fail(new Error('Codex App Server was closed.'));
  }
}

import os from 'node:os';
import path from 'node:path';
import { createReadStream } from 'node:fs';
import { readdir, stat } from 'node:fs/promises';
import readline from 'node:readline';

import { isolatedCodexHomes } from '@/modules/project-isolation/index.js';
import { sessionsDb, projectsDb } from '@/modules/database/index.js';
import { createCodexRolloutReadStream } from '@/shared/index.js';
import {
  buildLookupMap,
  normalizeSessionName,
  readFileTimestamps,
} from '@/shared/utils.js';
import type { IProviderSessionSynchronizer } from '@/shared/interfaces.js';

type ParsedSession = {
  sessionId: string;
  projectPath: string;
  sessionName?: string;
};

/**
 * Session indexer for Codex transcript artifacts.
 */
export class CodexSessionSynchronizer implements IProviderSessionSynchronizer {
  private readonly provider = 'codex' as const;
  private readonly codexHome = path.join(os.homedir(), '.codex');

  /**
   * Incrementally scans active and archived Codex rollouts. Calling without a
   * cursor scans all available history, which is used for a first-time index.
   */
  async synchronize(since?: Date): Promise<number> {
    const homes = [this.codexHome, ...isolatedCodexHomes()];
    const firstNameMap = new Map<string, string>();
    const latestNameMap = new Map<string, string>();
    for (const home of homes) {
      for (const [id, title] of await buildLookupMap(path.join(home, 'session_index.jsonl'), 'id', 'thread_name')) firstNameMap.set(id, title);
      for (const [id, title] of await this.buildLatestNameMap(path.join(home, 'session_index.jsonl'))) latestNameMap.set(id, title);
    }
    const activeFiles = (await Promise.all(homes.map((home) => this.findRolloutFiles(path.join(home, 'sessions'))))).flat();
    const archivedFiles = (await Promise.all(homes.map((home) => this.findRolloutFiles(path.join(home, 'archived_sessions'))))).flat();
    // Prefer active files, then plain JSONL over a compressed duplicate left
    // during a native Codex archive/compaction transition.
    const files = [...activeFiles, ...archivedFiles].sort((left, right) => {
      const archiveOrder = Number(left.includes(`${path.sep}archived_sessions${path.sep}`))
        - Number(right.includes(`${path.sep}archived_sessions${path.sep}`));
      if (archiveOrder !== 0) return archiveOrder;
      // A same-thread continuation has a newer timestamp and an extra segment
      // UUID. Index it before its frozen predecessor; prefer plain/compressed
      // format only when both paths represent the same physical segment.
      const leftSegment = path.basename(left).replace(/\.zst$/, '');
      const rightSegment = path.basename(right).replace(/\.zst$/, '');
      const segmentOrder = leftSegment === rightSegment ? 0 : leftSegment < rightSegment ? 1 : -1;
      return segmentOrder || Number(left.endsWith('.zst')) - Number(right.endsWith('.zst'));
    });

    let processed = 0;
    const handledIds = new Set<string>();
    for (const filePath of files) {
      const filenameId = this.getSessionIdFromFilename(filePath);
      if (filenameId && handledIds.has(filenameId)) continue;
      const existingByFilename = filenameId
        ? sessionsDb.getSessionByProviderSessionId(filenameId) ?? sessionsDb.getSessionById(filenameId)
        : null;
      const isArchived = filePath.includes(`${path.sep}archived_sessions${path.sep}`);
      const fileStat = since ? await stat(filePath) : null;
      const fileIsUnchanged = Boolean(since && fileStat && fileStat.mtime <= since);
      const wasStoredInCodexArchive = Boolean(
        existingByFilename?.jsonl_path?.includes(`${path.sep}archived_sessions${path.sep}`),
      );
      const archiveStateMatches = existingByFilename
        && (isArchived ? Boolean(existingByFilename.isArchived) : !wasStoredInCodexArchive);
      const metadataMatches = Boolean(
        existingByFilename
        && existingByFilename.jsonl_path === filePath
        && archiveStateMatches
        && !this.hasProviderTitleChanged(existingByFilename, filenameId, firstNameMap, latestNameMap),
      );
      if (fileIsUnchanged && metadataMatches) {
        handledIds.add(filenameId as string);
        continue;
      }
      if (fileIsUnchanged && filenameId && !existingByFilename) {
        // Historical backfill is an explicit operation. A normal incremental
        // scan must not silently import every old compressed/archived rollout.
        handledIds.add(filenameId);
        continue;
      }

      const parsed = await this.processSessionFile(filePath, firstNameMap, latestNameMap);
      if (!parsed) {
        continue;
      }
      if (handledIds.has(parsed.sessionId)) continue;
      handledIds.add(parsed.sessionId);

      const existingSession = sessionsDb.getSessionByProviderSessionId(parsed.sessionId)
        ?? sessionsDb.getSessionById(parsed.sessionId);
      const timestamps = await readFileTimestamps(filePath);
      const indexedSessionId = sessionsDb.createSession(
        parsed.sessionId,
        this.provider,
        parsed.projectPath,
        parsed.sessionName,
        timestamps.createdAt,
        timestamps.updatedAt,
        filePath
      );
      if (isArchived || existingSession?.jsonl_path?.includes(`${path.sep}archived_sessions${path.sep}`)) {
        // Mirror native Codex archive moves, but preserve an app-level archive
        // when its active rollout merely changes in place.
        sessionsDb.updateSessionIsArchived(indexedSessionId, isArchived);
      }
      processed += 1;
    }

    return processed;
  }

  /**
   * Parses and upserts one Codex session JSONL file.
   */
  async synchronizeFile(filePath: string): Promise<string | null> {
    if (!this.isRolloutFile(filePath)) {
      return null;
    }

    const home = isolatedCodexHomes().find((candidate) => filePath.startsWith(candidate + path.sep)) ?? this.codexHome;
    const indexPath = path.join(home, 'session_index.jsonl');
    const firstNameMap = await buildLookupMap(indexPath, 'id', 'thread_name');
    const latestNameMap = await this.buildLatestNameMap(indexPath);
    const parsed = await this.processSessionFile(filePath, firstNameMap, latestNameMap);
    if (!parsed) {
      return null;
    }

    const existingSession = sessionsDb.getSessionByProviderSessionId(parsed.sessionId)
      ?? sessionsDb.getSessionById(parsed.sessionId);
    const timestamps = await readFileTimestamps(filePath);
    const sessionId = sessionsDb.createSession(
      parsed.sessionId,
      this.provider,
      parsed.projectPath,
      parsed.sessionName,
      timestamps.createdAt,
      timestamps.updatedAt,
      filePath
    );
    if (filePath.includes(`${path.sep}archived_sessions${path.sep}`)
      || existingSession?.jsonl_path?.includes(`${path.sep}archived_sessions${path.sep}`)) {
      sessionsDb.updateSessionIsArchived(
        sessionId,
        filePath.includes(`${path.sep}archived_sessions${path.sep}`),
      );
    }
    return sessionId;
  }

  /**
   * Extracts session metadata from one Codex JSONL session file.
   */
  private async processSessionFile(
    filePath: string,
    firstNameMap: Map<string, string>,
    latestNameMap: Map<string, string>,
  ): Promise<ParsedSession | null> {
    const parsed = await this.extractFirstValidRolloutData(filePath, (rawData) => {
      const data = rawData as Record<string, unknown>;
      const payload = data.payload as Record<string, unknown> | undefined;
      const sessionId = typeof payload?.id === 'string' ? payload.id : undefined;
      const projectPath = typeof payload?.cwd === 'string' ? payload.cwd : undefined;

      if (!sessionId || !projectPath) {
        return null;
      }

      return {
        sessionId,
        projectPath,
        isSubagent: payload ? this.isSubagentSessionMeta(payload) : false,
      };
    });

    if (!parsed || parsed.isSubagent) {
      return null;
    }

    // A thread a session was edited off is left on disk on purpose, but it is
    // nobody's conversation any more. Re-indexing it would add a sidebar entry
    // for the version the user edited away from — and for a session that was
    // itself discovered from disk, whose app id is its original thread id, it
    // would hand the row back to that thread.
    if (sessionsDb.isProviderSessionSuperseded(parsed.sessionId, this.provider)) {
      return null;
    }

    // App-created sessions are keyed by an app id, so disk-discovered provider
    // ids must be resolved through the provider-id mapping first.
    const existingSession = sessionsDb.getSessionByProviderSessionId(parsed.sessionId)
      ?? sessionsDb.getSessionById(parsed.sessionId);
    const isolatedHome = isolatedCodexHomes().find((home) => filePath.startsWith(home + path.sep));
    if (isolatedHome) {
      const project = projectsDb.getProjectById(path.basename(path.dirname(isolatedHome)));
      if (!project) return null;
      if (parsed.projectPath !== project.project_path) {
        // An explicitly imported session may retain its original cwd. Trust only
        // an existing DB mapping to this exact private snapshot, never container metadata alone.
        if (existingSession?.project_path !== project.project_path || existingSession.jsonl_path !== filePath) return null;
        parsed.projectPath = project.project_path;
      }
    }
    if (isolatedHome && existingSession && existingSession.project_path !== parsed.projectPath) return null;
    const existingSessionName = existingSession?.custom_name;
    if (existingSessionName && existingSessionName !== 'Untitled Codex Session') {
      if (existingSession?.session_id === existingSession.provider_session_id
        && this.hasProviderTitleChanged(existingSession, parsed.sessionId, firstNameMap, latestNameMap)) {
        return {
          ...parsed,
          sessionName: normalizeSessionName(latestNameMap.get(parsed.sessionId), 'Untitled Codex Session'),
        };
      }
      return {
        ...parsed,
        sessionName: normalizeSessionName(existingSessionName, 'Untitled Codex Session'),
      };
    }

    let sessionName = latestNameMap.get(parsed.sessionId);
    if (!sessionName) {
      sessionName = await this.extractLastAgentMessageFromEnd(filePath);
    }

    return {
      ...parsed,
      sessionName: normalizeSessionName(sessionName, 'Untitled Codex Session'),
    };
  }

  private isRolloutFile(filePath: string): boolean {
    return filePath.endsWith('.jsonl') || filePath.endsWith('.jsonl.zst');
  }

  private getSessionIdFromFilename(filePath: string): string | null {
    const basename = path.basename(filePath);
    const uuid = basename.match(/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})(?:_[0-9a-f-]{36})?\.jsonl(?:\.zst)?$/i);
    return uuid?.[1] ?? null;
  }

  private hasProviderTitleChanged(
    existingSession: { session_id: string; provider_session_id?: string | null; custom_name?: string | null },
    sessionId: string | null,
    firstNameMap: Map<string, string>,
    latestNameMap: Map<string, string>,
  ): boolean {
    if (!sessionId || existingSession.session_id !== existingSession.provider_session_id) return false;
    const stored = existingSession.custom_name;
    const first = firstNameMap.get(sessionId);
    const latest = latestNameMap.get(sessionId);
    return Boolean(stored && first && latest && stored === first && latest !== first);
  }

  private async findRolloutFiles(root: string): Promise<string[]> {
    const files: string[] = [];
    const visit = async (directory: string): Promise<void> => {
      let entries;
      try {
        entries = await readdir(directory, { withFileTypes: true });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
        throw error;
      }
      for (const entry of entries) {
        const fullPath = path.join(directory, entry.name);
        if (entry.isDirectory()) await visit(fullPath);
        else if (entry.isFile() && this.isRolloutFile(fullPath)) files.push(fullPath);
      }
    };
    await visit(root);
    return files;
  }

  private async buildLatestNameMap(filePath: string): Promise<Map<string, string>> {
    const latest = new Map<string, string>();
    const stream = createReadStream(filePath);
    const lineReader = readline.createInterface({ input: stream, crlfDelay: Infinity });
    try {
      for await (const line of lineReader) {
        try {
          const row = JSON.parse(line) as Record<string, unknown>;
          if (typeof row.id === 'string' && typeof row.thread_name === 'string') {
            latest.set(row.id, row.thread_name);
          }
        } catch {
          // The index is append-only and may end with an incomplete line.
        }
      }
    } catch {
      // Missing index is expected for a fresh Codex profile.
    } finally {
      lineReader.close();
      stream.destroy();
    }
    return latest;
  }

  private async extractFirstValidRolloutData<T>(
    filePath: string,
    extractor: (parsedJson: unknown) => T | null | undefined,
  ): Promise<T | null> {
    const stream = createCodexRolloutReadStream(filePath);
    const lineReader = readline.createInterface({ input: stream, crlfDelay: Infinity });
    try {
      for await (const line of lineReader) {
        if (!line.trim()) continue;
        let parsed: unknown;
        try {
          parsed = JSON.parse(line);
        } catch {
          continue;
        }
        const extracted = extractor(parsed);
        if (extracted) return extracted;
      }
    } finally {
      lineReader.close();
      stream.destroy();
    }
    return null;
  }

  /**
   * Returns true when a session_meta payload belongs to a Codex sub-agent
   * thread (Codex >=0.144 collaboration spawn_agent, review, compact, etc.).
   * Sub-agent rollouts live in the same sessions tree as user sessions, so
   * they must be skipped here to stay out of the sidebar — the Codex
   * equivalent of the Claude synchronizer's subagent transcript skip.
   * Top-level sessions carry thread_source "user" and a string source
   * ("exec"/"cli"); sub-agents carry thread_source "subagent" and an object
   * source keyed by "subagent".
   */
  private isSubagentSessionMeta(payload: Record<string, unknown>): boolean {
    if (payload.thread_source === 'subagent') {
      return true;
    }

    const source = payload.source;
    return typeof source === 'object' && source !== null && 'subagent' in source;
  }

  private async extractLastAgentMessageFromEnd(filePath: string): Promise<string | undefined> {
    const stream = createCodexRolloutReadStream(filePath);
    const lineReader = readline.createInterface({ input: stream, crlfDelay: Infinity });
    let lastAgentMessage: string | undefined;
    try {
      for await (const rawLine of lineReader) {
        const line = rawLine.trim();
        if (!line) continue;
        let parsed: unknown;
        try {
          parsed = JSON.parse(line);
        } catch {
          continue;
        }

        const data = parsed as Record<string, unknown>;
        const eventType = typeof data.type === 'string' ? data.type : undefined;
        const payload = data.payload as Record<string, unknown> | undefined;
        const payloadType = typeof payload?.type === 'string' ? payload.type : undefined;
        const candidate = typeof payload?.last_agent_message === 'string'
          ? payload.last_agent_message
          : undefined;

        if (eventType === 'event_msg' && payloadType === 'task_complete' && candidate?.trim()) {
          lastAgentMessage = candidate;
        }
      }
    } catch {
      // Ignore missing/unreadable files so sync can continue.
    } finally {
      lineReader.close();
      stream.destroy();
    }

    return lastAgentMessage;
  }
}

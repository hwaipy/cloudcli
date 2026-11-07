import fs from 'node:fs';
import { createRequire } from 'node:module';

const bcrypt = createRequire(import.meta.url)('bcrypt') as { compareSync(password: string, hash: string): boolean };
import path from 'node:path';
import { createHmac, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';

type HubUser = {
  id: string;
  username: string;
  passwordHash: string;
  avatar: string | null;
  isAdmin: boolean;
  createdAt: string;
};

type HubAuthState = { jwtSecret: string; users: HubUser[]; legacyCacheOwner?: string; preferences?: Record<string, Record<string, unknown>> };
export type HubUserIdentity = { id: string; username: string; isAdmin: boolean };

export class HubAuthError extends Error {
  constructor(message: string, readonly status: number, readonly code?: string) {
    super(message);
    this.name = 'HubAuthError';
  }
}

function readState(filePath: string): HubAuthState {
  try {
    const state = JSON.parse(fs.readFileSync(filePath, 'utf8')) as HubAuthState;
    if (typeof state.jwtSecret !== 'string' || !Array.isArray(state.users)) throw new Error('invalid auth state');
    return state;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    const state = { jwtSecret: randomBytes(48).toString('base64url'), users: [] };
    writeState(filePath, state);
    return state;
  }
}

function writeState(filePath: string, state: HubAuthState): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
  const tempPath = `${filePath}.${process.pid}.tmp`;
  fs.writeFileSync(tempPath, JSON.stringify(state, null, 2), { mode: 0o600 });
  fs.chmodSync(tempPath, 0o600);
  fs.renameSync(tempPath, filePath);
}

function publicUser(user: HubUser): Omit<HubUser, 'passwordHash'> {
  const { passwordHash: _passwordHash, ...result } = user;
  return result;
}

function validateUsernamePassword(username: unknown, password: unknown): { username: string; password: string } {
  if (typeof username !== 'string' || !/^[a-zA-Z0-9_-]{3,32}$/.test(username.trim())) {
    throw new HubAuthError('Username must be 3-32 letters, numbers, underscores, or hyphens.', 400, 'HUB_AUTH_INVALID_INPUT');
  }
  if (typeof password !== 'string' || password.length < 8 || password.length > 256) {
    throw new HubAuthError('Password must contain 8-256 characters.', 400, 'HUB_AUTH_INVALID_INPUT');
  }
  return { username: username.trim(), password };
}

function passwordHash(password: string, salt = randomBytes(16).toString('hex')): string {
  return `${salt}:${scryptSync(password, salt, 64).toString('hex')}`;
}

function passwordMatches(password: string, encoded: string): boolean {
  // Existing backend accounts retain their password during Hub migration.
  if (/^\$2[aby]\$/.test(encoded)) return bcrypt.compareSync(password, encoded);
  const [salt, digest] = encoded.split(':');
  if (!salt || !digest) return false;
  const expected = Buffer.from(digest, 'hex');
  const actual = scryptSync(password, salt, expected.length);
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

/** Owns Hub user accounts and signs the browser's Hub session token, independent of backend user databases. */
export function createHubAuthService(filePath: string) {
  let state = readState(filePath);
  const save = () => writeState(filePath, state);
  const issueToken = (user: HubUser) => {
    const issuedAt = Math.floor(Date.now() / 1000);
    const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');
    const payload = Buffer.from(JSON.stringify({
      hubUserId: user.id,
      username: user.username,
      isAdmin: user.isAdmin,
      iat: issuedAt,
      exp: issuedAt + 7 * 24 * 60 * 60,
      iss: 'cloudcli-hub',
    })).toString('base64url');
    const unsigned = `${header}.${payload}`;
    const signature = createHmac('sha256', state.jwtSecret).update(unsigned).digest('base64url');
    return `${unsigned}.${signature}`;
  };
  const readTokenClaims = (token: string): { hubUserId: string } | null => {
    const parts = token.split('.');
    if (parts.length !== 3 || parts.some((part) => !part)) return null;
    const [headerPart, payloadPart, signaturePart] = parts;
    const unsigned = `${headerPart}.${payloadPart}`;
    const expected = createHmac('sha256', state.jwtSecret).update(unsigned).digest();
    let actual: Buffer;
    try { actual = Buffer.from(signaturePart, 'base64url'); } catch { return null; }
    if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) return null;
    try {
      const header = JSON.parse(Buffer.from(headerPart, 'base64url').toString('utf8')) as { alg?: unknown; typ?: unknown };
      const claims = JSON.parse(Buffer.from(payloadPart, 'base64url').toString('utf8')) as {
        hubUserId?: unknown;
        exp?: unknown;
        iat?: unknown;
        iss?: unknown;
      };
      const now = Math.floor(Date.now() / 1000);
      if (header.alg !== 'HS256' || header.typ !== 'JWT' || claims.iss !== 'cloudcli-hub'
        || typeof claims.hubUserId !== 'string' || !claims.hubUserId
        || typeof claims.exp !== 'number' || !Number.isFinite(claims.exp) || claims.exp <= now
        || typeof claims.iat !== 'number' || !Number.isFinite(claims.iat) || claims.iat > now + 60) return null;
      return { hubUserId: claims.hubUserId };
    } catch { return null; }
  };

  return {
    getPreferences(identity: HubUserIdentity) {
      return { success: true, preferences: state.preferences?.[identity.id] ?? {}, legacyBrowserCacheOwner: state.legacyCacheOwner === identity.id };
    },
    savePreferences(identity: HubUserIdentity, updates: Record<string, unknown>) {
      const allowed = new Set(['theme', 'userLanguage', 'tasksEnabled', 'projectSortOrder', 'claudePermissions', 'cursorPermissions', 'codexPermissions', 'opencodePermissions', 'codeEditorSettings', 'uiPreferences', 'selectedProvider', 'sidebarExpandedProjects']);
      if (Object.keys(updates).some((key) => !allowed.has(key))) throw new HubAuthError('Unknown preference key', 400);
      const next = { ...state.preferences, [identity.id]: { ...state.preferences?.[identity.id], ...updates } };
      const previous = state.preferences;
      state.preferences = next;
      try { save(); } catch (error) { state.preferences = previous; throw error; }
      return { success: true, preferences: next[identity.id] };
    },
    getStatus() {
      return { needsSetup: state.users.length === 0, isAuthenticated: false };
    },
    register(usernameInput: unknown, passwordInput: unknown) {
      if (state.users.length !== 0) throw new HubAuthError('Hub setup is already complete.', 403, 'HUB_AUTH_SETUP_COMPLETE');
      const { username, password } = validateUsernamePassword(usernameInput, passwordInput);
      const user: HubUser = {
        id: randomBytes(16).toString('hex'), username, passwordHash: passwordHash(password),
        avatar: null, isAdmin: true, createdAt: new Date().toISOString(),
      };
      state.users.push(user);
      save();
      return { success: true, user: publicUser(user), token: issueToken(user) };
    },
    login(usernameInput: unknown, passwordInput: unknown) {
      if (typeof usernameInput !== 'string' || typeof passwordInput !== 'string') {
        throw new HubAuthError('Invalid username or password.', 401, 'HUB_AUTH_INVALID_CREDENTIALS');
      }
      const user = state.users.find((candidate) => candidate.username === usernameInput.trim());
      if (!user || !passwordMatches(passwordInput, user.passwordHash)) {
        throw new HubAuthError('Invalid username or password.', 401, 'HUB_AUTH_INVALID_CREDENTIALS');
      }
      if (/^\$2[aby]\$/.test(user.passwordHash)) {
        user.passwordHash = passwordHash(passwordInput);
        save();
      }
      return { success: true, user: publicUser(user), token: issueToken(user) };
    },
    authenticate(token: string | null | undefined): HubUserIdentity | null {
      if (!token) return null;
      try {
        const claims = readTokenClaims(token);
        if (!claims) return null;
        const id = claims.hubUserId;
        const user = state.users.find((candidate) => candidate.id === id);
        return user ? { id: user.id, username: user.username, isAdmin: user.isAdmin } : null;
      } catch { return null; }
    },
    refresh(identity: HubUserIdentity) {
      const user = state.users.find((candidate) => candidate.id === identity.id);
      if (!user) throw new HubAuthError('Hub session is invalid.', 401, 'HUB_AUTH_INVALID_TOKEN');
      return { success: true, user: publicUser(user), token: issueToken(user) };
    },
    getUser(identity: HubUserIdentity) {
      const user = state.users.find((candidate) => candidate.id === identity.id);
      if (!user) throw new HubAuthError('Hub user was not found.', 404, 'HUB_AUTH_USER_NOT_FOUND');
      return { user: publicUser(user) };
    },
    listUsers(identity: HubUserIdentity) {
      if (!identity.isAdmin) throw new HubAuthError('Administrator access required.', 403, 'HUB_AUTH_ADMIN_REQUIRED');
      return { users: state.users.map(publicUser) };
    },
    createUser(identity: HubUserIdentity, usernameInput: unknown, passwordInput: unknown) {
      if (!identity.isAdmin) throw new HubAuthError('Administrator access required.', 403, 'HUB_AUTH_ADMIN_REQUIRED');
      const { username, password } = validateUsernamePassword(usernameInput, passwordInput);
      if (state.users.some((user) => user.username === username)) throw new HubAuthError('Username already exists.', 409, 'HUB_AUTH_USERNAME_CONFLICT');
      const user: HubUser = {
        id: randomBytes(16).toString('hex'), username, passwordHash: passwordHash(password),
        avatar: null, isAdmin: false, createdAt: new Date().toISOString(),
      };
      state.users.push(user);
      save();
      return { user: publicUser(user) };
    },
    updateUser(identity: HubUserIdentity, id: string, usernameInput: unknown, passwordInput?: unknown) {
      if (!identity.isAdmin) throw new HubAuthError('Administrator access required.', 403, 'HUB_AUTH_ADMIN_REQUIRED');
      const user = state.users.find((candidate) => candidate.id === id);
      if (!user) throw new HubAuthError('Hub user was not found.', 404, 'HUB_AUTH_USER_NOT_FOUND');
      if (typeof usernameInput !== 'string' || !/^[a-zA-Z0-9_-]{3,32}$/.test(usernameInput.trim())) {
        throw new HubAuthError('Username must be 3-32 letters, numbers, underscores, or hyphens.', 400, 'HUB_AUTH_INVALID_INPUT');
      }
      const username = usernameInput.trim();
      if (state.users.some((candidate) => candidate.id !== user.id && candidate.username === username)) {
        throw new HubAuthError('Username already exists.', 409, 'HUB_AUTH_USERNAME_CONFLICT');
      }
      user.username = username;
      if (passwordInput !== undefined) {
        if (typeof passwordInput !== 'string' || passwordInput.length < 8 || passwordInput.length > 256) {
          throw new HubAuthError('Password must contain 8-256 characters.', 400, 'HUB_AUTH_INVALID_INPUT');
        }
        user.passwordHash = passwordHash(passwordInput);
      }
      save();
      return { user: publicUser(user) };
    },
    updateOwnAccount(identity: HubUserIdentity, usernameInput: unknown, currentPassword: unknown, newPasswordInput?: unknown) {
      const user = state.users.find((candidate) => candidate.id === identity.id);
      if (!user || typeof currentPassword !== 'string' || !passwordMatches(currentPassword, user.passwordHash)) {
        throw new HubAuthError('Current password is incorrect.', 403, 'HUB_AUTH_PASSWORD_INVALID');
      }
      if (typeof usernameInput !== 'string' || !/^[a-zA-Z0-9_-]{3,32}$/.test(usernameInput.trim())) {
        throw new HubAuthError('Username must be 3-32 letters, numbers, underscores, or hyphens.', 400, 'HUB_AUTH_INVALID_INPUT');
      }
      const username = usernameInput.trim();
      if (state.users.some((candidate) => candidate.id !== user.id && candidate.username === username)) {
        throw new HubAuthError('Username already exists.', 409, 'HUB_AUTH_USERNAME_CONFLICT');
      }
      user.username = username;
      if (newPasswordInput !== undefined) {
        if (typeof newPasswordInput !== 'string' || newPasswordInput.length < 8 || newPasswordInput.length > 256) {
          throw new HubAuthError('Password must contain 8-256 characters.', 400, 'HUB_AUTH_INVALID_INPUT');
        }
        user.passwordHash = passwordHash(newPasswordInput);
      }
      save();
      return { success: true, user: publicUser(user), token: issueToken(user) };
    },
    updateAvatar(identity: HubUserIdentity, avatar: unknown) {
      const user = state.users.find((candidate) => candidate.id === identity.id);
      if (!user) throw new HubAuthError('Hub user was not found.', 404, 'HUB_AUTH_USER_NOT_FOUND');
      if (avatar !== null && (typeof avatar !== 'string' || avatar.length > 400_000
        || !(avatar.startsWith('preset:') || /^data:image\/(jpeg|png|webp);base64,/.test(avatar)))) {
        throw new HubAuthError('Avatar must be a built-in option or a JPEG, PNG, or WebP image no larger than 256 KB.', 400, 'HUB_AUTH_INVALID_AVATAR');
      }
      user.avatar = avatar as string | null;
      save();
      return { success: true, user: publicUser(user) };
    },
  };
}

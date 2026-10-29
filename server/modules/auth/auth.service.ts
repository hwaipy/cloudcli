import { AppError } from '@/shared/utils.js';

type AuthUser = {
  id: number | bigint;
  username: string;
};

type AuthLoginUser = AuthUser & { password_hash: string };

type AuthDependencies = {
  platformMode?: boolean;
  users: {
    hasUsers(): boolean;
    createUser(username: string, passwordHash: string): AuthUser;
    listUsers(): Array<{ id: number; username: string }>;
    getUserByUsername(username: string): AuthLoginUser | undefined;
    getCredentialsById(userId: number): AuthLoginUser | undefined;
    updateAccount(userId: number, username: string, passwordHash?: string): void;
    updateLastLogin(userId: number): void;
  };
  transaction: {
    begin(): void;
    commit(): void;
    rollback(): void;
  };
  hashPassword(password: string): Promise<string>;
  comparePassword(password: string, passwordHash: string): Promise<boolean>;
  generateToken(user: AuthUser): string;
};

function numericUserId(userId: number | bigint): number {
  return Number(userId);
}

function isUniqueConstraintError(error: unknown): boolean {
  return typeof error === 'object'
    && error !== null
    && 'code' in error
    && error.code === 'SQLITE_CONSTRAINT_UNIQUE';
}

/**
 * Creates the Auth application service around explicit persistence, crypto,
 * transaction, and token dependencies.
 */
export function createAuthService(dependencies: AuthDependencies) {
  return {
    getStatus() {
      return {
        needsSetup: !dependencies.users.hasUsers(),
        isAuthenticated: false,
      };
    },

    async register(usernameInput: unknown, passwordInput: unknown) {
      const username = typeof usernameInput === 'string' ? usernameInput : '';
      const password = typeof passwordInput === 'string' ? passwordInput : '';

      if (!username || !password) {
        throw new AppError('Username and password are required', {
          code: 'AUTH_CREDENTIALS_REQUIRED',
          statusCode: 400,
        });
      }
      if (username.length < 3 || password.length < 6) {
        throw new AppError(
          'Username must be at least 3 characters, password at least 6 characters',
          { code: 'AUTH_CREDENTIALS_TOO_SHORT', statusCode: 400 },
        );
      }

      dependencies.transaction.begin();
      try {
        if (dependencies.users.hasUsers()) {
          throw new AppError('Initial setup is complete. Ask an administrator to add an account.', {
            code: 'AUTH_USER_ALREADY_CONFIGURED',
            statusCode: 403,
          });
        }

        const passwordHash = await dependencies.hashPassword(password);
        const user = dependencies.users.createUser(username, passwordHash);
        const token = dependencies.generateToken(user);
        dependencies.transaction.commit();
        dependencies.users.updateLastLogin(numericUserId(user.id));

        return {
          success: true,
          user: { id: user.id, username: user.username, isAdmin: true },
          token,
        };
      } catch (error) {
        dependencies.transaction.rollback();
        if (isUniqueConstraintError(error)) {
          throw new AppError('Username already exists', {
            code: 'AUTH_USERNAME_CONFLICT',
            statusCode: 409,
          });
        }
        throw error;
      }
    },

    listUsers(actor: unknown) {
      const users = dependencies.users.listUsers();
      if (!users.length || !actor || typeof actor !== 'object' || !('id' in actor)
        || Number(actor.id) !== users[0].id) {
        throw new AppError('Administrator access required.', { code: 'ADMIN_REQUIRED', statusCode: 403 });
      }
      return { users };
    },

    async createManagedUser(actor: unknown, usernameInput: unknown, passwordInput: unknown) {
      // Account creation is administrator-only; /register remains bootstrap-only.
      this.listUsers(actor);
      if (dependencies.platformMode) {
        throw new AppError('Multi-user accounts require token authentication.', {
          code: 'MULTI_USER_UNAVAILABLE', statusCode: 409,
        });
      }
      const username = typeof usernameInput === 'string' ? usernameInput.trim() : '';
      const password = typeof passwordInput === 'string' ? passwordInput : '';
      if (username.length < 3 || password.length < 6) {
        throw new AppError('Username must be at least 3 characters, password at least 6 characters', {
          code: 'AUTH_CREDENTIALS_TOO_SHORT', statusCode: 400,
        });
      }
      try {
        const passwordHash = await dependencies.hashPassword(password);
        const user = dependencies.users.createUser(username, passwordHash);
        return { user: { id: user.id, username: user.username } };
      } catch (error) {
        if (isUniqueConstraintError(error)) {
          throw new AppError('Username already exists', { code: 'AUTH_USERNAME_CONFLICT', statusCode: 409 });
        }
        throw error;
      }
    },

    async updateOwnAccount(actor: unknown, usernameInput: unknown, currentPasswordInput: unknown, newPasswordInput: unknown) {
      const userId = actor && typeof actor === 'object' && 'id' in actor ? Number(actor.id) : NaN;
      const account = Number.isSafeInteger(userId) ? dependencies.users.getCredentialsById(userId) : undefined;
      if (!account) throw new AppError('Account not found.', { code: 'AUTH_USER_REQUIRED', statusCode: 401 });
      if (typeof currentPasswordInput !== 'string' || !await dependencies.comparePassword(currentPasswordInput, account.password_hash)) {
        throw new AppError('Current password is incorrect.', { code: 'AUTH_INVALID_CREDENTIALS', statusCode: 401 });
      }
      return this.updateAccountRecord(userId, usernameInput, newPasswordInput);
    },

    async updateManagedUser(actor: unknown, userIdInput: unknown, usernameInput: unknown, newPasswordInput: unknown) {
      this.listUsers(actor);
      if (dependencies.platformMode) throw new AppError('Multi-user accounts require token authentication.', { code: 'MULTI_USER_UNAVAILABLE', statusCode: 409 });
      const userId = Number(userIdInput);
      if (!Number.isSafeInteger(userId) || userId <= 0 || !dependencies.users.getCredentialsById(userId)) {
        throw new AppError('Account not found.', { code: 'AUTH_USER_NOT_FOUND', statusCode: 404 });
      }
      if (Number((actor as AuthUser).id) === userId) {
        throw new AppError('Use account settings to change your own profile.', { code: 'AUTH_SELF_UPDATE_REQUIRED', statusCode: 400 });
      }
      return this.updateAccountRecord(userId, usernameInput, newPasswordInput);
    },

    async updateAccountRecord(userId: number, usernameInput: unknown, newPasswordInput: unknown) {
      const username = typeof usernameInput === 'string' ? usernameInput.trim() : '';
      const newPassword = typeof newPasswordInput === 'string' ? newPasswordInput : '';
      if (username.length < 3 || (newPasswordInput !== undefined && newPassword.length < 6)) {
        throw new AppError('Username must be at least 3 characters, password at least 6 characters', { code: 'AUTH_CREDENTIALS_TOO_SHORT', statusCode: 400 });
      }
      try {
        const passwordHash = newPasswordInput === undefined ? undefined : await dependencies.hashPassword(newPassword);
        dependencies.users.updateAccount(userId, username, passwordHash);
        return { user: { id: userId, username } };
      } catch (error) {
        if (isUniqueConstraintError(error)) throw new AppError('Username already exists', { code: 'AUTH_USERNAME_CONFLICT', statusCode: 409 });
        throw error;
      }
    },

    async login(usernameInput: unknown, passwordInput: unknown) {
      const username = typeof usernameInput === 'string' ? usernameInput : '';
      const password = typeof passwordInput === 'string' ? passwordInput : '';
      if (!username || !password) {
        throw new AppError('Username and password are required', {
          code: 'AUTH_CREDENTIALS_REQUIRED',
          statusCode: 400,
        });
      }

      const user = dependencies.users.getUserByUsername(username);
      const validPassword = user
        ? await dependencies.comparePassword(password, user.password_hash)
        : false;
      if (!user || !validPassword) {
        throw new AppError('Invalid username or password', {
          code: 'AUTH_INVALID_CREDENTIALS',
          statusCode: 401,
        });
      }

      dependencies.users.updateLastLogin(numericUserId(user.id));
      return {
        success: true,
        user: {
          id: user.id,
          username: user.username,
          isAdmin: dependencies.users.listUsers()[0]?.id === Number(user.id),
        },
        token: dependencies.generateToken(user),
      };
    },

    getCurrentUser(user: unknown) {
      const account = user as AuthUser;
      return { user: {
        ...account,
        isAdmin: dependencies.users.listUsers()[0]?.id === Number(account.id),
      } };
    },

    refreshSession(user: unknown) {
      if (
        typeof user !== 'object'
        || user === null
        || !('id' in user)
        || !('username' in user)
        || (typeof user.id !== 'number' && typeof user.id !== 'bigint')
        || typeof user.username !== 'string'
      ) {
        throw new AppError('Authenticated user is required', {
          code: 'AUTH_USER_REQUIRED',
          statusCode: 401,
        });
      }

      return { token: dependencies.generateToken(user as AuthUser) };
    },

    logout() {
      return { success: true, message: 'Logged out successfully' };
    },
  };
}

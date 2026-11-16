import { api } from '@/shared/api';
import type { FolderSuggestion } from '@/shared/types';

type BrowseFilesystemResponse = {
  path?: string;
  suggestions?: FolderSuggestion[];
  error?: string;
};

type CreateFolderResponse = {
  success?: boolean;
  path?: string;
  error?: string;
  details?: string;
};

type CreateProjectPayload = {
  strictFileIsolation?: boolean;
  path: string;
  customName?: string;
};

type CreateProjectApiError = {
  code?: string;
  message?: string;
  details?: unknown;
};

type CreateProjectResponse = {
  success?: boolean;
  project?: Record<string, unknown>;
  error?: string | CreateProjectApiError;
  details?: string;
  message?: string;
};

const parseJson = async <T>(response: Response): Promise<T> => {
  const data = (await response.json()) as T;
  return data;
};

const resolveCreateProjectErrorMessage = (responseData: CreateProjectResponse): string | null => {
  if (typeof responseData.details === 'string' && responseData.details.trim().length > 0) {
    return responseData.details;
  }

  if (typeof responseData.error === 'string' && responseData.error.trim().length > 0) {
    return responseData.error;
  }

  if (responseData.error && typeof responseData.error === 'object') {
    const errorObject = responseData.error as { message?: unknown; details?: unknown };

    if (typeof errorObject.details === 'string' && errorObject.details.trim().length > 0) {
      return errorObject.details;
    }

    if (typeof errorObject.message === 'string' && errorObject.message.trim().length > 0) {
      return errorObject.message;
    }

    if (
      errorObject.details
      && typeof errorObject.details === 'object'
      && typeof (errorObject.details as { projectPath?: unknown }).projectPath === 'string'
    ) {
      return `Project path already exists: ${(errorObject.details as { projectPath: string }).projectPath}`;
    }
  }

  if (typeof responseData.message === 'string' && responseData.message.trim().length > 0) {
    return responseData.message;
  }

  return null;
};

export const browseFilesystemFolders = async (pathToBrowse: string, backendId?: string) => {
  const response = await api.browseFilesystem(pathToBrowse, backendId);
  const data = await parseJson<BrowseFilesystemResponse>(response);

  if (!response.ok) {
    throw new Error(data.error || 'Failed to browse filesystem');
  }

  return {
    path: data.path || pathToBrowse,
    suggestions: (data.suggestions || []) as FolderSuggestion[],
  };
};

export const createFolderInFilesystem = async (folderPath: string, backendId?: string) => {
  const response = await api.createFolder(folderPath, backendId);
  const data = await parseJson<CreateFolderResponse>(response);

  if (!response.ok) {
    throw new Error(data.error || 'Failed to create folder');
  }

  return data.path || folderPath;
};

export const createProjectRequest = async (payload: CreateProjectPayload, backendId?: string) => {
  const response = await api.createProject(payload, backendId);
  const data = await parseJson<CreateProjectResponse>(response);

  if (!response.ok) {
    throw new Error(resolveCreateProjectErrorMessage(data) || 'Failed to create project');
  }

  return data.project;
};

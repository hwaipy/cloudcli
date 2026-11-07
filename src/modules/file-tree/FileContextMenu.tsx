import { useMemo } from 'react';
import type { ReactNode } from 'react';

import { useTranslation } from 'react-i18next';
import { Copy, Download, FileText, FolderPlus, Pencil, RefreshCw, Trash2, Upload, type LucideIcon } from 'lucide-react';

import { useAppContextMenu } from '@/shared/ui';
import { cn } from '@/shared/utils';

type FileContextItem = {
  name: string;
  type: 'file' | 'directory';
  path: string;
  size?: number;
  modified?: string;
  permissionsRwx?: string;
  children?: FileContextItem[];
  [key: string]: unknown;
};

type ContextMenuAction = {
  key: string;
  label: string;
  icon?: LucideIcon;
  onSelect?: () => void;
  isDanger?: boolean;
  isDisabled?: boolean;
  shortcut?: string;
  showDividerBefore?: boolean;
};

/** Rendered by FileTreeNode to show the right-click actions available on one file or directory row. */
export default function FileContextMenu({
  children,
  item,
  onRename,
  onDelete,
  onNewFile,
  onNewFolder,
  onUpload,
  onRefresh,
  onCopyPath,
  onDownload,
  isLoading = false,
  className = '',
}: {
  children: ReactNode;
  item?: FileContextItem | null;
  onRename?: (item: FileContextItem) => void;
  onDelete?: (item: FileContextItem) => void;
  onNewFile?: (path: string) => void;
  onNewFolder?: (path: string) => void;
  onUpload?: (path: string) => void;
  onRefresh?: () => void;
  onCopyPath?: (item: FileContextItem) => void;
  onDownload?: (item: FileContextItem) => void;
  isLoading?: boolean;
  className?: string;
}) {
  const { t } = useTranslation();
  const openContextMenu = useAppContextMenu();
  const menuActions = useMemo<ContextMenuAction[]>(() => {
    if (item?.type === 'file') {
      return [
        {
          key: 'rename',
          icon: Pencil,
          label: t('fileTree.context.rename', 'Rename'),
          onSelect: () => onRename?.(item),
        },
        {
          key: 'delete',
          icon: Trash2,
          label: t('fileTree.context.delete', 'Delete'),
          onSelect: () => onDelete?.(item),
          isDanger: true,
        },
        {
          key: 'copyPath',
          icon: Copy,
          label: t('fileTree.context.copyPath', 'Copy Path'),
          onSelect: () => onCopyPath?.(item),
          showDividerBefore: true,
        },
        {
          key: 'download',
          icon: Download,
          label: t('fileTree.context.download', 'Download'),
          onSelect: () => onDownload?.(item),
        },
      ];
    }

    if (item?.type === 'directory') {
      return [
        {
          key: 'newFile',
          icon: FileText,
          label: t('fileTree.context.newFile', 'New File'),
          onSelect: () => onNewFile?.(item.path),
        },
        {
          key: 'newFolder',
          icon: FolderPlus,
          label: t('fileTree.context.newFolder', 'New Folder'),
          onSelect: () => onNewFolder?.(item.path),
        },
        {
          key: 'upload',
          icon: Upload,
          label: t('fileTree.context.upload', 'Upload Files'),
          onSelect: () => onUpload?.(item.path),
        },
        {
          key: 'rename',
          icon: Pencil,
          label: t('fileTree.context.rename', 'Rename'),
          onSelect: () => onRename?.(item),
          showDividerBefore: true,
        },
        {
          key: 'delete',
          icon: Trash2,
          label: t('fileTree.context.delete', 'Delete'),
          onSelect: () => onDelete?.(item),
          isDanger: true,
        },
        {
          key: 'copyPath',
          icon: Copy,
          label: t('fileTree.context.copyPath', 'Copy Path'),
          onSelect: () => onCopyPath?.(item),
          showDividerBefore: true,
        },
        {
          key: 'download',
          icon: Download,
          label: t('fileTree.context.download', 'Download'),
          onSelect: () => onDownload?.(item),
        },
      ];
    }

    return [
      {
        key: 'newFile',
        icon: FileText,
        label: t('fileTree.context.newFile', 'New File'),
        onSelect: () => onNewFile?.(''),
      },
      {
        key: 'newFolder',
        icon: FolderPlus,
        label: t('fileTree.context.newFolder', 'New Folder'),
        onSelect: () => onNewFolder?.(''),
      },
      {
        key: 'upload',
        icon: Upload,
        label: t('fileTree.context.upload', 'Upload Files'),
        onSelect: () => onUpload?.(''),
      },
      {
        key: 'refresh',
        icon: RefreshCw,
        label: t('fileTree.context.refresh', 'Refresh'),
        onSelect: onRefresh,
        showDividerBefore: true,
      },
    ];
  }, [item, onCopyPath, onDelete, onDownload, onNewFile, onNewFolder, onRefresh, onRename, onUpload, t]);

  const handlers: Record<string, unknown> = { rename: onRename, delete: onDelete, copyPath: onCopyPath, download: onDownload, newFile: onNewFile, newFolder: onNewFolder, upload: onUpload, refresh: onRefresh };
  return <div className={cn('contents', className)} onContextMenu={(event) => openContextMenu(event,
    menuActions.filter((action) => handlers[action.key]).map((action) => ({ ...action, disabled: isLoading || action.isDisabled, onSelect: () => action.onSelect?.() })),
  )}>{children}</div>;
}

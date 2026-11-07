import { copyTextToClipboard } from '@/shared/utils';
import type { DragEvent } from 'react';
import { ChevronDownIcon, ChevronUpIcon, CornerDownRightIcon, GripVerticalIcon, PaperclipIcon, PencilIcon, Trash2Icon } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { useMessageSendAnimation } from '@/modules/chat/context/MessageSendAnimationContext';
import { useOptionalAuth } from '@/modules/auth';
import { LongUserMessage } from '@/modules/chat/transcript/LongUserMessage';
import { AccountAvatar, useAppContextMenu } from '@/shared/ui';

type QueuedMessageCardProps = {
  content: string;
  attachmentCount?: number;
  position: number;
  total: number;
  isDropTarget: boolean;
  canSteer: boolean;
  onEdit: () => void;
  onSteer: () => void;
  onDelete: () => void;
  onMoveUp: () => void;
  onMoveDown: () => void;
  onDragStart: (event: DragEvent<HTMLButtonElement>) => void;
  onDragOver: (event: DragEvent<HTMLDivElement>) => void;
  onDrop: (event: DragEvent<HTMLDivElement>) => void;
  onDragEnd: () => void;
};

/** Used by QueuedMessagesList to show queued turns like user messages with queue controls. */
export default function QueuedMessageCard({
  content, attachmentCount = 0, position, total, isDropTarget, canSteer,
  onEdit, onSteer, onDelete, onMoveUp, onMoveDown, onDragStart, onDragOver, onDrop, onDragEnd,
}: QueuedMessageCardProps) {
  const openContextMenu = useAppContextMenu();
  const { t } = useTranslation('chat');
  const sendAnimationRef = useMessageSendAnimation(content);
  const account = useOptionalAuth()?.user;
  const accountName = account?.username || t('message.you', 'You');
  return (
    <div
      className="flex w-full justify-end px-3 sm:px-0"
      onContextMenu={(event) => openContextMenu(event, [
        { key: 'copy', label: '复制消息', onSelect: async () => { if (!await copyTextToClipboard(content)) throw new Error('复制失败'); } },
        ...(canSteer ? [{ key: 'steer', label: 'Steer：立即追加指令', onSelect: onSteer }] : []),
        { key: 'edit', label: '编辑排队消息', onSelect: onEdit },
        { key: 'up', label: '上移', disabled: position === 1, onSelect: onMoveUp },
        { key: 'down', label: '下移', disabled: position === total, onSelect: onMoveDown },
        { key: 'delete', label: '删除排队消息', isDanger: true, showDividerBefore: true, onSelect: onDelete },
      ])}
      onDragOver={onDragOver}
      onDrop={onDrop}
    >
      <div className="flex max-w-full items-end gap-2 sm:max-w-[85%] md:max-w-md lg:max-w-lg xl:max-w-xl">
        <div ref={sendAnimationRef} className="min-w-0 flex-1 sm:flex-initial">
          <div className={`group max-w-full rounded-2xl rounded-br-md border px-3 py-2 text-foreground shadow-sm sm:px-4 ${isDropTarget ? 'border-primary/50 bg-primary/10 ring-2 ring-primary/20' : 'border-border/60 bg-muted/60 dark:bg-gray-800/60'}`}>
            {content.trim() ? (
              <LongUserMessage content={content} />
            ) : (
              <div className="text-sm text-muted-foreground">{t('input.queue.attachmentsOnly', { defaultValue: 'Attachments' })}</div>
            )}
            {attachmentCount > 0 && (
              <div className="mt-1 flex items-center gap-1 text-xs text-muted-foreground">
                <PaperclipIcon className="h-3 w-3" aria-hidden="true" />
                <span>{attachmentCount}</span>
              </div>
            )}
            <div className="mt-1 flex flex-wrap items-center justify-end gap-0.5 text-xs text-muted-foreground">
              {canSteer && (
                <button type="button" onClick={onSteer}
                  aria-label={t('input.queue.steer', { defaultValue: 'Steer' })}
                  title={t('input.queue.steer', { defaultValue: 'Steer' })}
                  className="flex h-7 items-center gap-1 rounded px-1.5 hover:bg-accent hover:text-foreground">
                  <CornerDownRightIcon className="h-3.5 w-3.5" aria-hidden="true" />
                  {t('input.queue.steer', { defaultValue: 'Steer' })}
                </button>
              )}
              <button type="button" onClick={onMoveUp} disabled={position === 1}
                aria-label={t('input.queue.moveUp', { defaultValue: 'Move queued message up' })}
                title={t('input.queue.moveUp', { defaultValue: 'Move queued message up' })}
                className="flex h-7 w-7 items-center justify-center rounded hover:bg-accent hover:text-foreground disabled:cursor-not-allowed disabled:opacity-30 disabled:hover:bg-transparent">
                <ChevronUpIcon className="h-4 w-4" />
              </button>
              <button type="button" onClick={onMoveDown} disabled={position === total}
                aria-label={t('input.queue.moveDown', { defaultValue: 'Move queued message down' })}
                title={t('input.queue.moveDown', { defaultValue: 'Move queued message down' })}
                className="flex h-7 w-7 items-center justify-center rounded hover:bg-accent hover:text-foreground disabled:cursor-not-allowed disabled:opacity-30 disabled:hover:bg-transparent">
                <ChevronDownIcon className="h-4 w-4" />
              </button>
              {total > 1 && (
                <button
                  type="button"
                  draggable
                  onDragStart={onDragStart}
                  onDragEnd={onDragEnd}
                  aria-label={t('input.queue.drag', { defaultValue: 'Drag to reorder queued message {{position}}', position })}
                  title={t('input.queue.drag', { defaultValue: 'Drag to reorder queued message {{position}}', position })}
                  className="flex h-7 w-7 cursor-grab items-center justify-center rounded text-muted-foreground hover:bg-accent hover:text-foreground active:cursor-grabbing">
                  <GripVerticalIcon className="h-3.5 w-3.5" />
                </button>
              )}
              <button type="button" onClick={onEdit}
                aria-label={t('input.queue.edit', { defaultValue: 'Edit queued message' })}
                title={t('input.queue.edit', { defaultValue: 'Edit queued message' })}
                className="flex h-7 w-7 items-center justify-center rounded text-muted-foreground hover:bg-accent hover:text-foreground">
                <PencilIcon className="h-3.5 w-3.5" />
              </button>
              <button type="button" onClick={onDelete}
                aria-label={t('input.queue.delete', { defaultValue: 'Delete queued message' })}
                title={t('input.queue.delete', { defaultValue: 'Delete queued message' })}
                className="flex h-7 w-7 items-center justify-center rounded text-muted-foreground hover:bg-destructive/10 hover:text-destructive">
                <Trash2Icon className="h-3.5 w-3.5" />
              </button>
            </div>
          </div>
        </div>
        <div data-message-send-identity className="flex max-w-20 shrink-0 flex-col items-center gap-1 pt-0.5">
          <AccountAvatar username={accountName} avatar={account?.avatar} className="h-8 w-8 text-sm" />
          <span className="max-w-20 truncate text-center text-[11px] text-muted-foreground" title={accountName}>{accountName}</span>
        </div>
      </div>
    </div>
  );
}

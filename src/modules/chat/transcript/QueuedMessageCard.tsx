import type { DragEvent } from 'react';
import { ChevronDownIcon, ChevronUpIcon, CornerDownRightIcon, GripVerticalIcon, PaperclipIcon, PencilIcon, Trash2Icon } from 'lucide-react';
import { useTranslation } from 'react-i18next';

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

/** Used by QueuedMessagesList to show one queued turn as a compact, reorderable row. */
export default function QueuedMessageCard({
  content, attachmentCount = 0, position, total, isDropTarget, canSteer,
  onEdit, onSteer, onDelete, onMoveUp, onMoveDown, onDragStart, onDragOver, onDrop, onDragEnd,
}: QueuedMessageCardProps) {
  const { t } = useTranslation('chat');
  return (
    <div
      className={`group flex h-9 min-w-0 items-center gap-1 px-1.5 text-sm ${isDropTarget ? 'bg-primary/10' : 'hover:bg-muted/60'}`}
      onDragOver={onDragOver}
      onDrop={onDrop}
    >
      <button
        type="button"
        draggable={total > 1}
        onDragStart={onDragStart}
        onDragEnd={onDragEnd}
        aria-label={t('input.queue.drag', { defaultValue: 'Drag to reorder queued message {{position}}', position })}
        title={t('input.queue.drag', { defaultValue: 'Drag to reorder queued message {{position}}', position })}
        className="shrink-0 cursor-grab rounded p-1 text-muted-foreground/70 hover:text-foreground active:cursor-grabbing"
      >
        <GripVerticalIcon className="h-3.5 w-3.5" />
      </button>
      <CornerDownRightIcon className="h-3.5 w-3.5 shrink-0 text-muted-foreground/60" aria-hidden="true" />
      <span
        title={content || t('input.queue.edit', { defaultValue: 'Edit queued message' })}
        className="min-w-0 flex-1 truncate px-1 text-foreground/90"
      >
        {content.replace(/\s+/g, ' ').trim() || t('input.queue.attachmentsOnly', { defaultValue: 'Attachments' })}
      </span>
      {attachmentCount > 0 && (
        <span className="flex shrink-0 items-center gap-0.5 text-xs text-muted-foreground">
          <PaperclipIcon className="h-3 w-3" />{attachmentCount}
        </span>
      )}
      {canSteer && (
        <button type="button" onClick={onSteer}
          aria-label={t('input.queue.steer', { defaultValue: 'Steer' })}
          className="flex shrink-0 items-center gap-1 rounded px-1.5 py-1 text-xs text-muted-foreground hover:bg-accent hover:text-foreground">
          <CornerDownRightIcon className="h-3.5 w-3.5" aria-hidden="true" />
          {t('input.queue.steer', { defaultValue: 'Steer' })}
        </button>
      )}
      <button type="button" onClick={onMoveUp} disabled={position === 1}
        aria-label={t('input.queue.moveUp', { defaultValue: 'Move queued message up' })}
        title={t('input.queue.moveUp', { defaultValue: 'Move queued message up' })}
        className="flex h-7 w-7 shrink-0 items-center justify-center rounded text-muted-foreground hover:bg-accent hover:text-foreground disabled:cursor-not-allowed disabled:opacity-30 disabled:hover:bg-transparent">
        <ChevronUpIcon className="h-4 w-4" />
      </button>
      <button type="button" onClick={onMoveDown} disabled={position === total}
        aria-label={t('input.queue.moveDown', { defaultValue: 'Move queued message down' })}
        title={t('input.queue.moveDown', { defaultValue: 'Move queued message down' })}
        className="flex h-7 w-7 shrink-0 items-center justify-center rounded text-muted-foreground hover:bg-accent hover:text-foreground disabled:cursor-not-allowed disabled:opacity-30 disabled:hover:bg-transparent">
        <ChevronDownIcon className="h-4 w-4" />
      </button>
      <button type="button" onClick={onEdit}
        aria-label={t('input.queue.edit', { defaultValue: 'Edit queued message' })}
        title={t('input.queue.edit', { defaultValue: 'Edit queued message' })}
        className="flex h-7 w-7 shrink-0 items-center justify-center rounded text-muted-foreground hover:bg-accent hover:text-foreground">
        <PencilIcon className="h-3.5 w-3.5" />
      </button>
      <button type="button" onClick={onDelete}
        aria-label={t('input.queue.delete', { defaultValue: 'Delete queued message' })}
        title={t('input.queue.delete', { defaultValue: 'Delete queued message' })}
        className="shrink-0 rounded p-1 text-muted-foreground hover:bg-destructive/10 hover:text-destructive">
        <Trash2Icon className="h-3.5 w-3.5" />
      </button>
    </div>
  );
}

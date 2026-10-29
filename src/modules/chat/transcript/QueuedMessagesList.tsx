import { useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';

import QueuedMessageCard from '@/modules/chat/transcript/QueuedMessageCard';
import type { QueuedDraft } from '@/shared/types';

type QueuedMessagesListProps = {
  queuedDrafts: QueuedDraft[];
  canSteer: boolean;
  onEdit: (id: string) => void;
  onDelete: (id: string) => void;
  onReorder: (sourceId: string, targetId: string) => void;
  onSteer: (id: string) => void;
};

/** Rendered after the active response in ChatMessagesPane so queued turns scroll with the transcript. */
export default function QueuedMessagesList({ queuedDrafts, canSteer, onEdit, onDelete, onReorder, onSteer }: QueuedMessagesListProps) {
  const { t } = useTranslation('chat');
  const draggedQueueIdRef = useRef<string | null>(null);
  // The highlighted destination helps track a drag within the transcript.
  const [dropTargetId, setDropTargetId] = useState<string | null>(null);

  if (queuedDrafts.length === 0) return null;

  return (
    <div aria-label={t('input.queue.list', { defaultValue: 'Queued messages' })} className="overflow-hidden rounded-lg border border-border/70 bg-muted/20">
      {queuedDrafts.map((queuedDraft, index) => {
        const id = queuedDraft.id ?? 'legacy';
        return (
          <QueuedMessageCard
            key={id}
            content={queuedDraft.content}
            attachmentCount={queuedDraft.uploadedAttachments?.length ?? queuedDraft.attachments.length}
            position={index + 1}
            total={queuedDrafts.length}
            isDropTarget={dropTargetId === id}
            canSteer={canSteer && id !== 'legacy' && !!queuedDraft.content.trim() && queuedDraft.attachments.length === 0 && (queuedDraft.uploadedAttachments?.length ?? 0) === 0}
            onEdit={() => onEdit(id)}
            onSteer={() => onSteer(id)}
            onDelete={() => onDelete(id)}
            onMoveUp={() => onReorder(id, queuedDrafts[index - 1]?.id ?? id)}
            onMoveDown={() => onReorder(id, queuedDrafts[index + 1]?.id ?? id)}
            onDragStart={(event) => {
              draggedQueueIdRef.current = id;
              event.dataTransfer.effectAllowed = 'move';
              event.dataTransfer.setData('text/plain', id);
            }}
            onDragOver={(event) => {
              if (!draggedQueueIdRef.current || draggedQueueIdRef.current === id) return;
              event.preventDefault();
              setDropTargetId(id);
            }}
            onDrop={(event) => {
              event.preventDefault();
              const sourceId = draggedQueueIdRef.current;
              draggedQueueIdRef.current = null;
              setDropTargetId(null);
              if (sourceId && sourceId !== id) onReorder(sourceId, id);
            }}
            onDragEnd={() => { draggedQueueIdRef.current = null; setDropTargetId(null); }}
          />
        );
      })}
    </div>
  );
}

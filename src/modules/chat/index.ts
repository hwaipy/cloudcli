export { default as ChatInterface } from '@/modules/chat/ChatInterface';
export { getClaudeSettings } from '@/modules/chat/utils/chatStorage';

// Workspace retains history while resetting project-specific composer state.
export { useSessionStore } from '@/modules/chat/hooks/useSessionStore';

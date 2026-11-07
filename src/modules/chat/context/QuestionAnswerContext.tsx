import { createContext } from 'react';

/** ChatInterface supplies acknowledged card replies to transcript question controls. */
export const QuestionAnswerContext = createContext<((text: string) => Promise<void>) | null>(null);

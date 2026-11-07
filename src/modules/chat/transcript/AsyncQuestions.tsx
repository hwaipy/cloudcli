import { useContext, useEffect, useState } from 'react';

import { QuestionAnswerContext } from '@/modules/chat/context/QuestionAnswerContext';

type AsyncQuestionsProps = { questions: unknown };

/** Used by MessageComponent to keep asynchronous Codex questions and their answers together. */
export function AsyncQuestions({ questions }: AsyncQuestionsProps) {
  const sendAnswer = useContext(QuestionAnswerContext);
  // Custom replies stay inside their question instead of overwriting the main draft.
  const [custom, setCustom] = useState<Record<number, string>>({});
  // Block repeated clicks while the acknowledged send is travelling to the server.
  const [sending, setSending] = useState<number | null>(null);
  // A failed transport leaves the card retryable and preserves the custom reply.
  const [error, setError] = useState('');
  const activeSending = sending !== null && Array.isArray(questions) && !questions[sending]?.answered ? sending : null;
  useEffect(() => {
    if (activeSending === null) return;
    const timer = window.setTimeout(() => { setSending(null); setError('尚未确认回答，请检查连接后重试。'); }, 31000);
    return () => window.clearTimeout(timer);
  }, [activeSending]);
  if (!Array.isArray(questions)) return null;
  return <div className="space-y-3">
    {questions.map((raw, index) => {
      if (!raw || typeof raw.title !== 'string') return null;
      const options = Array.isArray(raw.options) ? raw.options.filter((value: unknown): value is string => typeof value === 'string') : [];
      const answered = raw.answered === true;
      const disabled = answered || activeSending !== null || !sendAnswer;
      const reply = async (answer: string) => {
        if (disabled || !answer.trim()) return;
        setSending(index); setError('');
        try { await sendAnswer(`回答「${raw.title}」：${answer.trim()}`); }
        catch { setSending(null); setError('回答发送失败，请重试。'); }
      };
      return <section key={index} className="rounded-xl border border-border bg-muted/30 p-3">
        <p className="mb-2 font-medium">{raw.title}</p>
        <div className="flex flex-wrap gap-2">{options.map((option: string) => <button key={option} type="button" disabled={disabled} aria-pressed={answered && raw.answer === option} onClick={() => void reply(option)} className={`rounded-lg border px-3 py-2 text-left text-sm disabled:cursor-default ${answered && raw.answer === option ? 'border-primary bg-primary/10 text-primary' : 'border-border bg-background hover:bg-accent disabled:opacity-50'}`}>{answered && raw.answer === option ? '✓ ' : ''}{option}</button>)}</div>
        {answered ? <p role="status" className="mt-2 text-sm text-muted-foreground">已回答：{raw.answer}</p> : <form onSubmit={(event) => { event.preventDefault(); void reply(custom[index] || ''); }} className="mt-2 flex gap-2">
          <input disabled={disabled} aria-label={`自定义回答：${raw.title}`} value={custom[index] || ''} onChange={(event) => setCustom((previous) => ({ ...previous, [index]: event.target.value }))} onKeyDown={(event) => { if (event.key === 'Enter' && event.nativeEvent.isComposing) event.preventDefault(); }} className="min-w-0 flex-1 rounded-lg border border-border bg-background px-2 py-1 text-sm" placeholder="输入其他回答，回车发送" />
          <button type="submit" disabled={disabled || !custom[index]?.trim()} className="rounded-lg px-2 py-1 text-sm hover:bg-accent disabled:opacity-40">发送</button>
        </form>}
        {activeSending === index && !answered && <p role="status" className="mt-2 text-xs text-muted-foreground">发送中…</p>}
        {error && !answered && <p role="alert" className="mt-2 text-xs text-destructive">{error}</p>}
      </section>;
    })}
  </div>;
}

import { sessionsDb } from '@/modules/database/index.js';
import { broadcastSessionUpserted } from '@/modules/websocket/index.js';
import { generateSessionTitle } from '@/modules/providers/services/session-title-generator.service.js';
import type { LLMProvider } from '@/shared/types.js';

/** Starts bounded background title inference; revisions cancel updates after a manual rename. */
export function createSessionAutoTitleService(overrides: {
  generate?: typeof generateSessionTitle;
  apply?: (sessionId:string,expected:string,title:string)=>boolean;
  broadcast?: (sessionId:string)=>Promise<unknown>;
} = {}) {
  const generate=overrides.generate ?? generateSessionTitle;
  const apply=overrides.apply ?? ((id,expected,title)=>sessionsDb.updateSessionCustomNameIfUnchanged(id,expected,title));
  const broadcast=overrides.broadcast ?? broadcastSessionUpserted;
  const jobs=new Map<string,object>();
  let inFlight=0;
  return {
    cancel(sessionId:string) { jobs.delete(sessionId); },
    async schedule(sessionId:string,provider:LLMProvider,message:string,temporaryTitle:string,model?:string) {
      if(!message.trim() || inFlight>=4 || jobs.has(sessionId)) return;
      const job={};jobs.set(sessionId,job);inFlight++;
      try {
        const title=await generate(provider,message,model);
        if(title && jobs.get(sessionId)===job && apply(sessionId,temporaryTitle,title)) await broadcast(sessionId);
      } catch { /* An unavailable model must never break sending or expose credentials in logs. */ }
      finally { inFlight--; if(jobs.get(sessionId)===job) jobs.delete(sessionId); }
    },
  };
}

/** Singleton used by session creation and manual renaming in the providers service. */
export const sessionAutoTitleService=createSessionAutoTitleService({
  generate: (provider,message,model) => process.env.NODE_ENV === 'test' || process.env.NODE_TEST_CONTEXT
    ? Promise.resolve(null) : generateSessionTitle(provider,message,model),
});

// Summarise a chat request body, whichever wire format it is in.
import { isResponsesRequest, responsesText } from '../translate/request.mjs';

/**
 * What kind of chat request is this? Returns null when it is not a chat request at all (pass it through).
 * @returns {{format: 'aws'|'responses', modelId: string, userText: string, agentMode: string|null, metadata: object, conversationId: string|null}|null}
 */
export function describeChat(body) {
  const cur = body?.conversationState?.currentMessage?.userInputMessage;
  if (cur) {
    return { format: 'aws', modelId: cur.modelId, userText: cur.content || '', agentMode: body.agentMode ?? null, metadata: {}, conversationId: body.conversationState.conversationId ?? null };
  }
  if (isResponsesRequest(body)) {
    const items = typeof body.input === 'string' ? [{ role: 'user', content: body.input }] : body.input;
    const firstUser = items.find((i) => i && (i.type === undefined || i.type === 'message') && i.role === 'user');
    const md = body.metadata && typeof body.metadata === 'object' ? body.metadata : {};
    return { format: 'responses', modelId: body.model, userText: responsesText(firstUser?.content), agentMode: md['kiro:agent_mode'] ?? null, metadata: md, conversationId: md['kiro:conversation_id'] ?? md['kiro:root_conversation_id'] ?? null, tools: Array.isArray(body.tools) ? body.tools : [] };
  }
  return null;
}

/** What chatError() / the encoders need to know about the reply format Kiro expects. */
export const wireOf = (chat) => ({ format: chat?.format ?? 'aws', model: chat?.modelId, metadata: chat?.metadata, tools: chat?.tools });


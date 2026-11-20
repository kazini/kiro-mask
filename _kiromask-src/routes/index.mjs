import { handleChat } from './chat.mjs';
import { handleModels } from './models.mjs';
import { handleCompletions } from './completions.mjs';
import { handleMcp } from './mcp.mjs';
import { handleTelemetry, handleUpdate, handleUsage, handleAuth, handleOther } from './misc.mjs';

/**
 * Decide what kind of Kiro request this is. Kiro's service calls are JSON-RPC style: `POST /` with the operation
 * named in the `X-Amz-Target` header (e.g. "KiroRuntimeService.GenerateAssistantResponse"). The URL path is
 * still checked for operations addressed by path. Current Kiro builds send chat as `POST /v1/responses` instead.
 */
export function classify({ host, pathname, target = '' }) {
  const p = pathname.toLowerCase();
  const op = String(target).split('.').pop().toLowerCase();
  // Chat: the AWS operation (older builds / feature flags) or POST /v1/responses (the "create_response" transport).
  if (op === 'generateassistantresponse' || p.includes('generateassistantresponse') || p === '/v1/responses' || p === '/responses') return 'chat';
  if (op === 'listavailablemodels' || p.includes('listavailablemodels')) return 'models';
  if (op === 'generatecompletions' || p.includes('generatecompletions')) return 'completions';
  if (op === 'getusagelimits' || p.includes('getusagelimits')) return 'usage';
  if (op === 'invokemcp' || p === '/mcp' || p.startsWith('/mcp/')) return 'mcp';
  if (host.includes('auth.desktop.kiro.dev')) return 'auth';
  if (host.includes('telemetry') || op === 'sendtelemetryevent' || p === '/v1/metrics' || p === '/v1/traces') return 'telemetry';
  if (/metadata-(win32|darwin|linux)/.test(p)) return 'update';
  return 'other';
}

export const HANDLERS = { chat: handleChat, models: handleModels, completions: handleCompletions, usage: handleUsage, mcp: handleMcp, auth: handleAuth, telemetry: handleTelemetry, update: handleUpdate, other: handleOther };

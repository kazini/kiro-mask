// generateCompletions (inline autocomplete).
import { readBody } from '../util.mjs';
import { completeOnce } from '../providers/client.mjs';
import { json } from './common.mjs';

const SYSTEM = 'You are a code completion engine. Output ONLY the code that belongs at the <CURSOR> marker. No explanations, no markdown fences, no repetition of surrounding code.';

export const stripFences = (t) => String(t || '').replace(/^\s*```[\w+-]*\n?/, '').replace(/\n?```\s*$/, '');

export async function handleCompletions(ctx) {
  const { app, cfg, req, res, log } = ctx;
  const mode = cfg.get('completions');
  const nativeOk = cfg.get('kiro_endpoint.models') && !cfg.get('kiro_endpoint.auth_fake_login');

  if (mode === 'passthrough' || (mode == null && !app.state.customActive && nativeOk)) return app.pass(ctx);

  const r = mode === 'current' ? cfg.resolve(app.state.lastModel) : mode ? cfg.resolve(mode) : null;
  const entry = r && r !== 'native' ? r : mode === 'current' ? cfg.defaultEntry : null;
  if (!entry) { log('debug', 'completions blocked (custom model active)'); return res.destroy(); }

  const raw = await readBody(req);
  let fc = {};
  try { fc = JSON.parse(raw.toString('utf8')).fileContext || {}; } catch { /* empty */ }
  const left = String(fc.leftFileContent || '').slice(-6000);
  const right = String(fc.rightFileContent || '').slice(0, 2000);
  const lang = fc.programmingLanguage?.languageName || '';
  try {
    const text = stripFences(await completeOnce(entry, { system: SYSTEM, user: `File: ${fc.filename || 'unknown'} ${lang ? `(${lang})` : ''}\n\n${left}<CURSOR>${right}`, maxTokens: 128 }, { log }));
    log('debug', `completion via ${entry.id}: ${text.length} chars`);
    return json(res, 200, { completions: text.trim() ? [{ content: text, mostRelevantMissingImports: [], references: [] }] : [], modelId: null, nextToken: '', predictions: [] });
  } catch (e) {
    log('warn', `completions via ${entry.id} failed: ${e.message}`);
    return res.destroy();
  }
}

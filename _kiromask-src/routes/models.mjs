// ListAvailableModels: merge Kiro's models with configured custom models.
import fs from 'node:fs';
import path from 'node:path';
import { buildModelList } from './model-list.mjs';
import { jsonFor } from './common.mjs';

export function loadNativeCache(dir) {
  try { return JSON.parse(fs.readFileSync(path.join(dir, 'kiro_models.json'), 'utf8')); } catch { return null; }
}
export function saveNativeCache(dir, j) {
  try { fs.mkdirSync(dir, { recursive: true }); fs.writeFileSync(path.join(dir, 'kiro_models.json'), JSON.stringify(j, null, 2)); } catch { /* ignore */ }
}

export async function handleModels(ctx) {
  const { app, cfg, res, log } = ctx;
  const wantNative = cfg.get('kiro_endpoint.models') && !cfg.get('kiro_endpoint.auth_fake_login');
  const local = (upstream, why) => {
    const list = buildModelList(upstream, cfg, { includeNative: wantNative });
    log('info', `models → ${list.models.length} (${cfg.customModels.length} custom${why ? `; ${why}` : ''})`);
    return jsonFor(ctx, 200, list);
  };
  if (!wantNative) return local(null, 'Kiro models hidden');

  return app.pass(ctx, {
    timeoutMs: 8000,
    transform: (buf) => {
      const j = JSON.parse(buf.toString('utf8'));
      saveNativeCache(app.dataDir, j);
      const list = buildModelList(j, cfg, { includeNative: true });
      log('info', `models → ${list.models.length} (${(j.models || []).length} Kiro + ${cfg.customModels.length} custom)`);
      return Buffer.from(JSON.stringify(list));
    },
    // AWS down or erroring: still offer your models. Auth errors (4xx) pass through so Kiro can refresh its login.
    onStatus: (code) => { if (code >= 500) { local(loadNativeCache(app.dataDir), `AWS returned ${code}`); return true; } },
    onError: (e) => { local(loadNativeCache(app.dataDir), `AWS unreachable: ${e.message}`); return true; },
  });
}

// Validate a config file (default: the product's example) through the real loader:
//   node checks/06-config-loader.mjs [--config path]     or  KIROMASK_CONFIG=path
// Unset ${ENV} references are stubbed so no real secrets are needed. Never prints key values.
import path from 'node:path';
import { createCheck } from '../lib/check.mjs';
import { imp, KM } from '../lib/paths.mjs';

const arg = process.argv.indexOf('--config');
const file = path.resolve(arg > -1 ? process.argv[arg + 1] : process.env.KIROMASK_CONFIG || path.join(KM, 'kiromask.config.example.yaml'));
const { loadConfig } = await imp('config/load.mjs');
const t = createCheck(`Config loader: ${path.basename(file)}`);

const env = new Proxy({}, { get: (_, k) => (typeof k === 'string' ? 'stub-secret' : undefined) });
const cfg = loadConfig(file, { env });
t.eq(cfg.warnings.filter((w) => !/has no api_key/.test(w)), [], 'no configuration warnings');
t.info(`${cfg.providers.size} provider(s), ${cfg.customModels.length} model(s), native aliases: ${[...cfg.nativeAliases].join(', ') || '-'}`);

for (const m of cfg.customModels) {
  t.ok(cfg.resolve(m.id) === m, `${m.id}: resolvable by id`);
  for (const a of m.aliases) t.ok(cfg.resolve(a) === m || cfg.resolve(a)?.id !== undefined, `${m.id}: alias "${a}" resolves`);
  t.ok(Number.isInteger(m.maxTokens) && m.maxTokens > 0, `${m.id}: max_tokens is a positive integer (${m.maxTokens})`);
  t.ok(Number.isInteger(m.contextWindow) && m.contextWindow > 0, `${m.id}: context_window is a positive integer (${m.contextWindow})`);
  t.ok(/^https?:\/\//.test(m.provider.apiBase), `${m.id}: provider api_base is an http(s) URL`);
  t.ok(['openai', 'anthropic'].includes(m.provider.type), `${m.id}: provider type ${m.provider.type}`);
}
t.ok(['local', 'passthrough', 'current'].includes(cfg.get('session_title')) || !!cfg.resolve(cfg.get('session_title')), 'session_title is valid');
const dm = cfg.get('default_model');
t.ok(cfg.resolve(dm) !== null || dm === 'kiro-default', `default_model "${dm}" resolves (or is the Kiro default)`);
t.finish();

// Configuration: load YAML/JSON, merge over defaults, normalize providers, build the model registry.

import fs from 'node:fs';
import path from 'node:path';
import { parseYaml } from './yaml.mjs';

export const DEFAULTS = {
  proxy: {
    host: '127.0.0.1',
    port: 29974,
    // Only these hosts get TLS-intercepted; everything else is tunnelled untouched.
    intercept_hosts: ['*.amazonaws.com', '*.kiro.dev', 'kiro.dev'],
  },
  kiro: { exe_path: null, args: [], env: {} },
  launch: { exit_with_kiro: true, allow_running: false, companions: [] },
  // permissive: --ignore-certificate-errors + NODE_TLS_REJECT_UNAUTHORIZED=0 (inside the launched Kiro only)
  // pinned:     only certificates issued by our CA are accepted (experimental)
  tls: { mode: 'permissive' },
  kiro_endpoint: {
    telemetry: false,
    updates: false,
    models: true,
    force_toggle_usage_limits: null,
    auth_fake_login: false,
    start_blocking: false,
    strict_whitelist: false,
    block_telemetry_always: false,
    strip_metering: false,
    // once a custom model has been used, swallow other AWS calls so nothing is metered
    block_other_when_custom: true,
  },
  // how session titles are made: local | passthrough | current | <model name>
  session_title: 'local',
  // null | passthrough | current | <model name>
  completions: null,
  // default | enforce | disabled | { description, inputSchema, execute: {...} }
  web_search: 'default',
  // preamble: "default" = built-in stand-in for Kiro's server-side main prompt; "" = none; or your own text
  prompt: { system_override_file: null, preamble: 'default', prepend: '', append: '', as_system_message: true },
  model_list: { order: 'kiro-first', kiro_rate_unit: 'Kiro Credits', default_model: null },
  defaults: {
    max_tokens: 16384,
    retries: 2,
    timeout_s: 300,
    reasoning: 'drop', // drop | keep | native (experimental)
    tool_args: 'buffer', // buffer (validate+repair JSON) | stream
    errors: 'chat', // chat (show provider errors in the conversation) | http
    context_window: 200000,
  },
  // where Kiro Mask keeps its CA, logs, captures and caches. null = ./data inside the kiromask folder
  // (a relative path is resolved against the kiromask folder; --data-dir and $KIROMASK_HOME take priority)
  data_dir: null,
  debug: { verbose: false, log_file: true, log_keep: 20, capture_traffic: false },
  providers: {},
  default_model: 'kiro-default',
};

const isObj = (v) => v && typeof v === 'object' && !Array.isArray(v);

export function deepMerge(base, over) {
  if (!isObj(base) || !isObj(over)) return over === undefined ? base : over;
  const out = { ...base };
  for (const [k, v] of Object.entries(over)) out[k] = isObj(v) && isObj(base[k]) ? deepMerge(base[k], v) : v;
  return out;
}

const clone = (o) => JSON.parse(JSON.stringify(o));

/** Replace ${VAR} references in every string (leaves unknown vars empty and records a warning). */
function interpolate(value, env, warnings, where = '') {
  if (typeof value === 'string') {
    return value.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (_, name) => {
      if (env[name] === undefined) warnings.push(`${where}: environment variable ${name} is not set`);
      return env[name] ?? '';
    });
  }
  if (Array.isArray(value)) return value.map((v, i) => interpolate(v, env, warnings, `${where}[${i}]`));
  if (isObj(value)) return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, interpolate(v, env, warnings, where ? `${where}.${k}` : k)]));
  return value;
}

const trimSlash = (s) => String(s || '').replace(/\/+$/, '');
// Node 18 resolves "localhost" to ::1 first, which fails against gateways bound to IPv4 only.
const loopbackBase = (s) => s.replace(/^(https?:\/\/)localhost(?=[:/]|$)/i, '$1127.0.0.1');

function normalizeProvider(name, p, defaults, warnings) {
  const type = p.type;
  const prov = {
    name,
    type,
    apiBase: loopbackBase(trimSlash(p.api_base || (type === 'anthropic' ? 'https://api.anthropic.com/v1' : 'https://api.openai.com/v1'))),
    apiKey: p.api_key || (p.api_key_env && process.env[p.api_key_env]) || null,
    auth: p.auth || (type === 'anthropic' ? 'x-api-key' : 'bearer'),
    headers: p.headers || {},
    maxTokensParam: p.max_tokens_param || 'max_tokens',
    retries: p.retries ?? defaults.retries,
    timeoutMs: (p.timeout_s ?? defaults.timeout_s) * 1000,
    opts: {
      max_tokens: p.max_tokens,
      context_window: p.context_window,
      reasoning: p.reasoning,
      tool_args: p.tool_args,
      temperature: p.temperature,
      extra_body: p.extra_body,
      schema: p.schema,
      quirks: p.quirks,
      prompt_caching: p.prompt_caching,
    },
    description: p.description || '',
  };
  if (!prov.apiKey && prov.auth !== 'none' && !/^https?:\/\/(localhost|127\.|\[::1\]|0\.0\.0\.0)/.test(prov.apiBase)) {
    warnings.push(`provider "${name}" has no api_key (set api_key or api_key_env)`);
  }
  return prov;
}

export class Config {
  constructor(raw, { source = null, env = process.env } = {}) {
    this.source = source;
    this.warnings = [];
    raw = raw ? { ...raw } : {};
    if ('intent_classifier' in raw) { // the setting's old name
      if (!('session_title' in raw)) raw.session_title = raw.intent_classifier;
      delete raw.intent_classifier;
      this.warnings.push('intent_classifier was renamed to session_title (the old name still works; please rename it)');
    }
    const merged = deepMerge(clone(DEFAULTS), raw);
    // Unset ${VARS} only matter for providers that are actually enabled.
    const { providers: rawProviders, ...rest } = merged;
    this.raw = interpolate(rest, env, this.warnings);
    this.raw.providers = Object.fromEntries(
      Object.entries(rawProviders || {}).map(([name, p]) => [name, interpolate(p, env, isObj(p) && p.enabled ? this.warnings : [], `providers.${name}`)]),
    );
    this.#build();
    this.#validate();
  }

  #build() {
    const d = this.raw.defaults;
    this.providers = new Map();
    this.models = new Map(); // id -> entry
    this.lookup = new Map(); // name/alias (lowercase) -> entry
    this.nativeAliases = new Set();

    for (const [pname, p] of Object.entries(this.raw.providers || {})) {
      if (!p.enabled) continue;
      if (p.type === 'passthrough') {
        for (const m of p.models || []) {
          this.nativeAliases.add(String(m.name).toLowerCase());
          for (const a of m.alias || []) this.nativeAliases.add(String(a).toLowerCase());
        }
        continue;
      }
      if (!['openai', 'anthropic'].includes(p.type)) {
        this.warnings.push(`provider "${pname}": unknown type "${p.type}" (use openai, anthropic or passthrough; LiteLLM and similar gateways are OpenAI-compatible: use type openai)`);
        continue;
      }
      const prov = normalizeProvider(pname, p, d, this.warnings);
      this.providers.set(pname, prov);
      for (const m of p.models || []) {
        if (!m?.name) continue;
        const id = String(m.name);
        const entry = {
          id,
          provider: prov,
          displayName: m.display_name || id,
          description: m.description || prov.description || '',
          aliases: (m.alias || []).map(String),
          upstreamModel: m.upstream_model || id,
          maxTokens: m.max_tokens ?? prov.opts.max_tokens ?? d.max_tokens,
          contextWindow: m.context_window ?? prov.opts.context_window ?? d.context_window,
          reasoning: m.reasoning ?? prov.opts.reasoning ?? d.reasoning,
          toolArgs: m.tool_args ?? prov.opts.tool_args ?? d.tool_args,
          temperature: m.temperature ?? prov.opts.temperature,
          extraBody: { ...(prov.opts.extra_body || {}), ...(m.extra_body || {}) },
          schema: { simplify: true, strip: [], ...(prov.opts.schema || {}), ...(m.schema || {}) },
          quirks: { ...(prov.opts.quirks || {}), ...(m.quirks || {}) },
          promptCaching: m.prompt_caching ?? prov.opts.prompt_caching ?? (prov.type === 'anthropic'),
          headers: { ...prov.headers, ...(m.headers || {}) },
          supportsImages: m.supports_images ?? true,
        };
        if (this.models.has(id.toLowerCase())) {
          this.warnings.push(`duplicate model name "${id}" in provider "${pname}" ignored`);
          continue;
        }
        this.models.set(id.toLowerCase(), entry);
        this.lookup.set(id.toLowerCase(), entry);
        for (const a of entry.aliases) {
          if (!this.lookup.has(a.toLowerCase())) this.lookup.set(a.toLowerCase(), entry);
        }
      }
    }
  }

  /** Report typos and dangling references instead of silently misbehaving. */
  #validate() {
    const w = (m) => this.warnings.push(m);
    const oneOf = (key, v, allowed) => { if (v !== undefined && v !== null && !allowed.includes(v)) w(`${key}: "${v}" is not valid (use ${allowed.join(' | ')})`); };
    const r = this.raw;
    // Unknown keys are almost always typos; they would otherwise be ignored without a word.
    const known = (where, obj, ref) => {
      if (!isObj(obj) || !isObj(ref) || Object.keys(ref).length === 0) return; // an empty default ({}) is a free-form map
      for (const k of Object.keys(obj)) {
        if (!(k in ref)) w(`${where ? `${where}.` : ''}${k}: unknown setting (ignored)`);
        else known(where ? `${where}.${k}` : k, obj[k], ref[k]);
      }
    };
    const { providers: _p, ...restRaw } = r;
    const { providers: _dp, ...restDefaults } = DEFAULTS;
    known('', restRaw, restDefaults);
    oneOf('tls.mode', r.tls?.mode, ['permissive', 'pinned']);
    oneOf('defaults.reasoning', r.defaults?.reasoning, ['drop', 'keep', 'native']);
    oneOf('defaults.tool_args', r.defaults?.tool_args, ['buffer', 'stream']);
    oneOf('defaults.errors', r.defaults?.errors, ['chat', 'http']);
    oneOf('model_list.order', r.model_list?.order, ['kiro-first', 'custom-first']);
    if (r.data_dir != null && typeof r.data_dir !== 'string') w('data_dir must be a folder path (or null)');
    if (!Number.isInteger(r.debug?.log_keep) || r.debug.log_keep < 1) w(`debug.log_keep: "${r.debug?.log_keep}" must be a whole number of at least 1`);
    const port = r.proxy?.port;
    if (!Number.isInteger(port) || port < 0 || port > 65535) w(`proxy.port: "${port}" is not a valid port`);
    if (!Array.isArray(r.proxy?.intercept_hosts) || r.proxy.intercept_hosts.some((h) => typeof h !== 'string')) w('proxy.intercept_hosts must be a list of host patterns');

    const modelRef = (key, v, specials) => {
      if (v === undefined || v === null || specials.includes(v)) return;
      const hit = this.resolve(v);
      if (!hit || hit === 'native') w(`${key}: "${v}" is not a configured model`);
    };
    modelRef('session_title', r.session_title, ['local', 'passthrough', 'current']);
    modelRef('completions', r.completions, ['passthrough', 'current']);
    if (r.default_model && r.default_model !== 'kiro-default' && this.resolve(r.default_model) === null) w(`default_model: "${r.default_model}" is not a configured model`);
    modelRef('model_list.default_model', r.model_list?.default_model, []);

    const ws = r.web_search;
    if (ws !== undefined && ws !== null && typeof ws !== 'object' && !['default', 'enforce', 'enforced', 'aws-enforce', 'disabled', 'none', 'off', true, false].includes(ws)) {
      w(`web_search: "${ws}" is not valid (use default | enforce | disabled | a mapping)`);
    }
    for (const [name, p] of Object.entries(r.providers || {})) {
      if (!isObj(p) || !p.enabled || p.type === 'passthrough') continue;
      if (!Array.isArray(p.models) || p.models.length === 0) w(`provider "${name}" is enabled but lists no models`);
      for (const m of p.models || []) {
        oneOf(`provider "${name}" model "${m?.name}" reasoning`, m?.reasoning, ['drop', 'keep', 'native']);
        oneOf(`provider "${name}" model "${m?.name}" tool_args`, m?.tool_args, ['buffer', 'stream']);
      }
    }
    for (const [i, c] of (r.launch?.companions || []).entries()) if (!c?.command) w(`launch.companions[${i}] has no command`);
  }

  get(pathStr, fallback) {
    let v = this.raw;
    for (const k of pathStr.split('.')) {
      if (v && typeof v === 'object' && k in v) v = v[k];
      else return fallback;
    }
    return v;
  }

  /** Look a model up by id or alias. Returns the entry, 'native' for Kiro aliases, or null. */
  resolve(id) {
    if (id == null) return null;
    const key = String(id).toLowerCase();
    return this.lookup.get(key) || (this.nativeAliases.has(key) ? 'native' : null);
  }

  /** The configured default as a custom entry, or null if it points at Kiro/unknown. */
  get defaultEntry() {
    const r = this.resolve(this.raw.default_model);
    return r && r !== 'native' ? r : null;
  }

  get customModels() {
    return [...this.models.values()];
  }
}

export function parseConfigText(text, file = '') {
  return file.endsWith('.json') ? JSON.parse(text) : parseYaml(text);
}

/** Load a config file (YAML or JSON). Missing file => defaults. Throws on syntax errors. */
export function loadConfig(file, opts) {
  let raw = {};
  if (file && fs.existsSync(file)) raw = parseConfigText(fs.readFileSync(file, 'utf8'), file) ?? {};
  if (!isObj(raw)) throw new Error('config file must contain a mapping at the top level');
  return new Config(raw, { source: file ? path.resolve(file) : null, ...opts });
}

/** Locate a config file: an explicit path, else ./kiromask.config.{yaml,yml,json}. */
export function findConfigFile(explicit, cwd = process.cwd()) {
  if (explicit) return path.resolve(explicit);
  return ['kiromask.config.yaml', 'kiromask.config.yml', 'kiromask.config.json'].map((c) => path.resolve(cwd, c)).find((c) => fs.existsSync(c)) || null;
}

/** Poll the file and invoke onChange(newConfig) / onError(err) when it changes. Returns a stop function. */
export function watchConfig(file, current, { onChange, onError, intervalMs = 1500 }) {
  if (!file) return () => {};
  let last = fs.existsSync(file) ? fs.statSync(file).mtimeMs : 0;
  const timer = setInterval(() => {
    try {
      const m = fs.statSync(file).mtimeMs;
      if (m === last) return;
      last = m;
      onChange(loadConfig(file));
    } catch (e) {
      if (e.code !== 'ENOENT') onError?.(e);
    }
  }, intervalMs);
  timer.unref();
  return () => clearInterval(timer);
}

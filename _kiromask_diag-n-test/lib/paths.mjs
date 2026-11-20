// Locates the product under test and (optionally) real Kiro captures.
//   KIROMASK_DIR       product directory            (default: the folder that contains _kiromask_diag-n-test/)
//   KIROMASK_CAPTURES  recorded Kiro traffic          (a capture folder: what _kiromask_diag-n-test/capture.mjs writes, or one
//                      session folder of Kiro Mask's own debug.capture_traffic, <data>/captures/<time>/ — both use
//                      flows/NNNN_….json). Optional; checks that need it skip without it.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
export const KIT = path.resolve(here, '..');
export const KM = path.resolve(process.env.KIROMASK_DIR || path.join(KIT, '..'));
export const CAPTURES = process.env.KIROMASK_CAPTURES ? path.resolve(process.env.KIROMASK_CAPTURES) : null;

/** Import a module from the product's _kiromask-src/ directory. */
export const imp = (rel) => import(pathToFileURL(path.join(KM, '_kiromask-src', rel)).href);

const numeric = (re) => (a, b) => Number(re.exec(a)[1]) - Number(re.exec(b)[1]);
const isDir = (p) => { try { return fs.statSync(p).isDirectory(); } catch { return false; } };

/**
 * Two capture layouts are understood:
 *   flows   (capture.mjs, and Kiro Mask's own debug.capture_traffic since 0.3) <dir>/flows/NNNN_host_METHOD_path{.json,.req.json,.res.bin,.res.events.jsonl,.res.txt}
 *   posted  (Kiro Mask ≤ 0.2 debug.capture_traffic) <dir>/posted/request_N.json  +  <dir>/responses/response_N.bin
 * Returns { layout, requests, responses } with absolute paths, or null when no captures are configured.
 * `requests` are chat requests in EITHER wire format (AWS `conversationState`, or Responses `{model, input}`);
 * `responses` are real AWS event streams only.
 */
export function captureFiles() {
  if (!CAPTURES || !fs.existsSync(CAPTURES)) return null;
  const flows = path.join(CAPTURES, 'flows');
  if (isDir(flows)) {
    const names = fs.readdirSync(flows).sort();
    const requests = names.filter((f) => f.endsWith('.req.json')).map((f) => path.join(flows, f)).filter((f) => {
      try { const j = JSON.parse(fs.readFileSync(f, 'utf8')); return 'conversationState' in j || ('model' in j && 'input' in j); } catch { return false; }
    });
    const responses = names.filter((f) => f.endsWith('.res.events.jsonl')).map((f) => path.join(flows, f.replace(/\.events\.jsonl$/, '.bin'))).filter((f) => fs.existsSync(f));
    return { layout: 'flows', requests, responses };
  }
  const list = (sub, re) => {
    const d = path.join(CAPTURES, sub);
    return fs.existsSync(d) ? fs.readdirSync(d).filter((f) => re.test(f)).sort(numeric(re)).map((f) => path.join(d, f)) : [];
  };
  return { layout: 'posted', requests: list('posted', /^request_(\d+)\.json$/), responses: list('responses', /^response_(\d+)\.bin$/) };
}

/** Parse a captured chat request: { headers, kiro, target, format } where kiro is the request body and format is 'aws' | 'responses'. */
export const formatOf = (body) => ('conversationState' in body ? 'aws' : 'responses');
export const isTitleBody = (body) => body.agentMode === 'session-title' || body.metadata?.['kiro:agent_mode'] === 'session-title';
export function readRequest(file) {
  if (file.endsWith('.req.json')) {
    const meta = JSON.parse(fs.readFileSync(file.replace(/\.req\.json$/, '.json'), 'utf8'));
    const headers = meta.request?.headers || {};
    const kiro = JSON.parse(fs.readFileSync(file, 'utf8'));
    return { headers, kiro, target: headers['x-amz-target'] || null, host: meta.host, format: formatOf(kiro) };
  }
  const d = JSON.parse(fs.readFileSync(file, 'utf8'));
  const headers = d.headers || {};
  const kiro = JSON.parse(d.body);
  return { headers, kiro, target: headers['x-amz-target'] || null, host: null, format: formatOf(kiro) };
}

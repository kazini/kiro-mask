// What proxy configuration does this machine impose on applications? (env + OS settings)
import { run } from './procs.mjs';

const stripCreds = (v) => String(v).replace(/\/\/[^/@\s]*@/, '//***@');

export function envProxy(env = process.env) {
  const out = {};
  for (const k of ['HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'NO_PROXY', 'http_proxy', 'https_proxy', 'all_proxy', 'no_proxy', 'NODE_TLS_REJECT_UNAUTHORIZED', 'NODE_EXTRA_CA_CERTS', 'SSL_CERT_FILE', 'ELECTRON_RUN_AS_NODE', 'NODE_OPTIONS']) {
    if (env[k] !== undefined) out[k] = /PROXY/i.test(k) ? stripCreds(env[k]) : env[k];
  }
  return out;
}

export async function systemProxy(platform = process.platform) {
  const out = { env: envProxy() };
  if (platform === 'win32') {
    const key = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings';
    const reg = {};
    for (const v of ['ProxyEnable', 'ProxyServer', 'ProxyOverride', 'AutoConfigURL', 'AutoDetect']) {
      const t = await run('reg', ['query', key, '/v', v]);
      const m = t && new RegExp(`${v}\\s+REG_\\w+\\s+(.*)`).exec(t);
      if (m) reg[v] = stripCreds(m[1].trim());
    }
    out.windowsInternetSettings = reg;
    const w = await run('netsh', ['winhttp', 'show', 'proxy']);
    if (w) out.netshWinhttp = w.replace(/\s+/g, ' ').trim();
  } else if (platform === 'darwin') {
    const t = await run('scutil', ['--proxy']);
    if (t) out.scutil = stripCreds(t.replace(/\s+/g, ' ').trim());
  } else {
    const g = await run('gsettings', ['get', 'org.gnome.system.proxy', 'mode']);
    if (g) out.gsettingsMode = g.trim();
  }
  return out;
}

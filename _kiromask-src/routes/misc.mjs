// Small endpoints: telemetry, update checks, usage limits, authentication, and blocking.
import crypto from 'node:crypto';
import { json, jsonFor } from './common.mjs';

/**
 * Answer a call we are swallowing so the client carries on. CBOR clients (app.kiro.dev's web service) get an
 * empty CBOR map; JSON-RPC clients get AWS JSON 1.0; everything else a plain JSON ack.
 */
export const blocked = (ctx, why) => {
  const { req, res, log, info } = ctx;
  ctx.flow?.note({ handled: `blocked (${why})` });
  log('debug', `blocked (${why}): ${info.host}${info.pathname}${info.target ? ` [${info.target}]` : ''}`);
  if (/cbor/i.test(String(req.headers['content-type'] || '') + String(req.headers['smithy-protocol'] || ''))) {
    res.writeHead(200, { 'content-type': 'application/cbor', 'smithy-protocol': 'rpc-v2-cbor', 'content-length': 1 });
    return res.end(Buffer.from([0xa0]));
  }
  return jsonFor(ctx, 200, { status: 'ok' });
};

export function handleTelemetry(ctx) {
  const { app, cfg, res } = ctx;
  const ke = (k) => cfg.get(`kiro_endpoint.${k}`);
  if (!ke('telemetry') || app.state.customActive || ke('auth_fake_login') || (ke('block_telemetry_always') && ke('models'))) return blocked(ctx, 'telemetry');
  return app.pass(ctx);
}

export function handleUpdate(ctx) {
  const { app, cfg, res } = ctx;
  if (cfg.get('kiro_endpoint.updates') && !cfg.get('kiro_endpoint.auth_fake_login')) return app.pass(ctx);
  ctx.log('debug', 'update check suppressed');
  return json(res, 200, { currentRelease: app.state.kiroVersion || '0.0.0', releases: [] });
}

/** A structurally valid "nothing used" answer, shaped like Kiro's real GetUsageLimits response. */
export function syntheticUsage({ legacyFields = false, now = new Date() } = {}) {
  const reset = Math.floor(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1) / 1000);
  return {
    ...(legacyFields ? { daysUntilReset: null, limits: null } : {}),
    nextDateReset: reset,
    overageConfiguration: { overageStatus: 'DISABLED' },
    subscriptionInfo: { overageCapability: 'OVERAGE_INCAPABLE', subscriptionManagementTarget: 'PURCHASE', subscriptionTitle: 'KIRO FREE', type: 'Q_DEVELOPER_STANDALONE_FREE', upgradeCapability: 'UPGRADE_CAPABLE' },
    usageBreakdownList: [{
      bonuses: [], currency: 'USD', currentOverages: 0, currentOveragesWithPrecision: 0, currentUsage: 0, currentUsageWithPrecision: 0,
      displayName: 'Credit', displayNamePlural: 'Credits', nextDateReset: reset, overageCap: 0, overageCapWithPrecision: 0,
      overageCharges: 0, overageCredits: [], overageRate: 0, resourceType: 'CREDIT', unit: 'INVOCATIONS', usageLimit: 50, usageLimitWithPrecision: 50,
    }],
    userInfo: { userId: 'kiromask' },
  };
}

// Pass through by default (the credits you see are real). Answered locally only with fake login (no account to ask)
// or when force_toggle_usage_limits is false.
export function handleUsage(ctx) {
  const { app, cfg } = ctx;
  const force = cfg.get('kiro_endpoint.force_toggle_usage_limits');
  const local = cfg.get('kiro_endpoint.auth_fake_login') || force === false;
  if (!local) return app.pass(ctx);
  ctx.log('debug', 'usage limits → synthetic (nothing used)');
  return jsonFor(ctx, 200, syntheticUsage({ legacyFields: !ctx.req.headers['x-amz-target'] }));
}

const rnd = () => crypto.randomBytes(24).toString('base64url');

export function handleAuth(ctx) {
  const { app, cfg, info, res, log } = ctx;
  if (!cfg.get('kiro_endpoint.auth_fake_login')) return app.pass(ctx);
  const p = info.pathname.toLowerCase();
  if (/logout/.test(p)) { log('info', 'fake login: logout suppressed'); return json(res, 200, { message: 'ok' }); }
  if (/token|refresh/.test(p)) {
    log('info', 'fake login: synthetic token issued');
    return json(res, 200, {
      accessToken: `kiromask.${rnd()}`, expiresIn: 315360000, refreshToken: `kiromask.${rnd()}`,
      profileArn: 'arn:aws:codewhisperer:us-east-1:000000000000:profile/KIROMASK0',
    });
  }
  return json(res, 200, {});
}

export function handleOther(ctx) {
  const { app, cfg, info } = ctx;
  const ke = (k) => cfg.get(`kiro_endpoint.${k}`);
  if (ke('auth_fake_login')) return blocked(ctx, 'fake login');
  if (ke('strict_whitelist')) return blocked(ctx, 'strict whitelist');
  if (app.state.customActive && ke('block_other_when_custom') && /amazonaws\.com$/.test(info.host)) return blocked(ctx, 'custom model active');
  return app.pass(ctx);
}

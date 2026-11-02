'use strict';

// Antigravity limits provider: RPC snapshot plus the OAuth/probe helpers in
// this folder. Reached through providerFetchers() in src/shared/limits/collector.js.

const antigravityOAuth = require('./oauth');
const antigravityProbe = require('./probe');
const {
  normalizeLimitProvider
} = require('../../limits/core');
const { hashKey } = require('../../hashKey');
const {
  cleanPlanText,
  nowIso,
  planLabelFromParts,
  providerStatusFromError
} = require('../../limits/providerHelpers');

function groupedWindowGroupKey(window) {
  if (typeof window?.windowMinutes !== 'number') return '';
  const match = String(window?.label || '').trim().match(/^(.+?)\s+(?:5-hour|weekly)$/i);
  return match ? match[1].trim().toLowerCase() : '';
}

function mergeMissingOAuthGroups(local, existing) {
  const localWindows = Array.isArray(local?.windows) ? local.windows : [];
  const localGroups = new Set(localWindows.map(groupedWindowGroupKey).filter(Boolean));
  if (localGroups.size === 0) return local;
  const missingWindows = (existing?.windows || []).filter((window) => {
    const groupKey = groupedWindowGroupKey(window);
    return groupKey && !localGroups.has(groupKey);
  });
  if (missingWindows.length === 0) return local;
  return normalizeLimitProvider({
    ...local,
    windows: [...localWindows, ...missingWindows]
  });
}

function antigravityPlanLabelFromParts(...parts) {
  const text = parts.map((part) => String(part || '').trim()).find(Boolean) || '';
  const raw = cleanPlanText(text, ['google', 'ai']);
  if (!raw) return '';
  return planLabelFromParts(raw);
}

function mapAntigravitySnapshot(snapshot, { nowMs, source = 'rpc', account = null } = {}) {
  const updatedAt = nowIso(nowMs ?? Date.now());
  const accountEmail = String(snapshot?.accountEmail || account?.accountEmail || '').trim().toLowerCase();
  const accountLabel = snapshot?.accountPlan ? antigravityPlanLabelFromParts(snapshot.accountPlan) : '';
  const accountKeySeed = accountEmail || snapshot?.accountPlan || account?.id || 'default';
  const windows = Array.isArray(snapshot?.windows)
    ? snapshot.windows.map((window) => ({
        kind: window.kind,
        label: window.name,
        usedPercent: typeof window.remainingFraction === 'number'
          ? Math.max(0, Math.min(100, (1 - window.remainingFraction) * 100))
          : null,
        resetsAt: window.resetTime || null,
        resetDescription: window.resetDescription || '',
        windowMinutes: window.kind === 'session' ? 300 : window.kind === 'weekly' ? 10_080 : null,
        showMeter: window.showMeter !== false
      }))
    : (snapshot?.pools || []).map((pool) => ({
        kind: 'weekly',
        label: pool.name,
        usedPercent: Number.isFinite(pool.remainingFraction)
          ? Math.max(0, Math.min(100, (1 - pool.remainingFraction) * 100))
          : null,
        resetsAt: pool.resetTime || null,
        windowMinutes: null,
        showMeter: Number.isFinite(pool.remainingFraction)
      }));
  return normalizeLimitProvider({
    provider: 'antigravity',
    accountKey: accountEmail ? antigravityOAuth.accountKey(accountEmail) : hashKey('antigravity', accountKeySeed),
    accountLabel,
    accountEmail,
    source,
    sourceDetail: snapshot?.sourceDetail || '',
    // OAuth can identify the account and plan even when Google withholds both
    // quota payloads. Preserve that identity, but do not present an empty
    // response as a live zero-usage quota.
    status: windows.length > 0 ? 'ok' : 'unavailable',
    updatedAt,
    windows
  });
}

function antigravityAccountError(account, error, nowMs) {
  const verificationRequired = error?.status === 'verificationRequired';
  return normalizeLimitProvider({
    provider: 'antigravity',
    accountKey: account?.accountKey || antigravityOAuth.accountKey(account?.accountEmail),
    accountLabel: '',
    accountEmail: account?.accountEmail || '',
    source: 'oauth',
    sourceDetail: 'oauth',
    status: verificationRequired
      ? 'unauthorized'
      : error?.status === 'permissionDenied' ? 'unavailable' : providerStatusFromError(error),
    ...(verificationRequired ? { actionRequired: 'accountVerification' } : {}),
    updatedAt: nowIso(nowMs),
    windows: []
  });
}

// The language server is only reachable while Antigravity (IDE or `agy`) is
// running, so the local sign-in is otherwise invisible: after a restart the
// widget would only know the managed OAuth accounts, and anything that picks
// "an Antigravity account" (the subscription form) silently falls back to one
// of those even when this device's agy is signed in to someone else. The host
// remembers the last address a live probe reported (no token, address only)
// and the collector keeps offering it as an identity-only row until the
// language server answers again.
function rememberedLocalAccount(deps = {}) {
  let remembered = null;
  try {
    remembered = typeof deps.resolveAntigravityLocalAccount === 'function'
      ? deps.resolveAntigravityLocalAccount()
      : deps.antigravityLocalAccount;
  } catch (_) {
    return null;
  }
  const accountEmail = String(remembered?.accountEmail || '').trim().toLowerCase();
  if (!accountEmail || !accountEmail.includes('@')) return null;
  return { accountEmail, accountKey: antigravityOAuth.accountKey(accountEmail) };
}

function rememberedLocalProvider(remembered, error, nowMs) {
  return normalizeLimitProvider({
    provider: 'antigravity',
    accountKey: remembered.accountKey,
    accountLabel: '',
    accountEmail: remembered.accountEmail,
    source: 'rpc',
    status: error ? providerStatusFromError(error) : 'notConfigured',
    updatedAt: nowIso(nowMs),
    windows: []
  });
}

function observeLocalAccount(provider, deps = {}) {
  const accountEmail = String(provider?.accountEmail || '').trim();
  if (!provider?.accountKey || !accountEmail) return;
  try {
    deps.onAntigravityLocalAccountObserved?.({ accountEmail });
  } catch (_) {
    // Remembering the address is best effort; the live row is already correct.
  }
}

async function fetchAntigravityLimits(options = {}, deps = {}) {
  const nowMs = (deps.now || Date.now)();
  const probeFn = deps.antigravityProbe || antigravityProbe.probe;
  const scope = options.limitRefreshScope?.provider === 'antigravity' ? options.limitRefreshScope : null;
  const accounts = antigravityOAuth.normalizeManagedAccounts(
    options.antigravityManagedAccounts || deps.antigravityManagedAccounts,
    { includeCredentials: true }
  )
    .filter((account) => account.enabled !== false)
    .filter((account) => !scope
      || (!scope.accountKey || scope.accountKey === account.accountKey)
      && (!scope.accountEmail || scope.accountEmail === account.accountEmail));

  // Every configured managed account, disabled ones included: a remembered
  // local address the user already manages (or switched off) is not offered a
  // second time as a separate identity.
  const managedKeys = new Set(antigravityOAuth.normalizeManagedAccounts(
    options.antigravityManagedAccounts || deps.antigravityManagedAccounts
  ).map((account) => account.accountKey).filter(Boolean));
  const remembered = rememberedLocalAccount(deps);
  const rememberedOffered = remembered
    && !managedKeys.has(remembered.accountKey)
    && scope?.sourceDetail !== 'oauth'
    && (!scope || (!scope.accountKey || scope.accountKey === remembered.accountKey)
      && (!scope.accountEmail || scope.accountEmail.toLowerCase() === remembered.accountEmail))
    ? remembered
    : null;

  if (accounts.length === 0 && !scope) {
    try {
      const local = mapAntigravitySnapshot(await probeFn(deps), { nowMs, source: 'rpc' });
      observeLocalAccount(local, deps);
      return local;
    } catch (error) {
      if (rememberedOffered) return rememberedLocalProvider(rememberedOffered, error, nowMs);
      return normalizeLimitProvider({
        provider: 'antigravity',
        accountKey: '',
        accountLabel: '',
        source: 'rpc',
        status: providerStatusFromError(error),
        updatedAt: nowIso(nowMs),
        windows: []
      });
    }
  }

  const localPromise = scope?.sourceDetail === 'oauth'
    ? Promise.resolve(null)
    : probeFn(deps).then(
        (snapshot) => mapAntigravitySnapshot(snapshot, { nowMs, source: 'rpc' }),
        () => null
      );
  const remotePromise = Promise.all(accounts.map(async (account) => {
    try {
      const snapshot = await antigravityOAuth.fetchRemoteSnapshot(account, {
        ...deps,
        collapsePools: antigravityProbe._collapsePools,
        quotaSummaryWindows: antigravityProbe._quotaSummaryWindows,
        onCredentialRenewed: (managedAccount, credentials, previous) => (
          deps.onAntigravityCredentialsRenewed?.({ account: managedAccount, credentials, previous })
        )
      });
      return mapAntigravitySnapshot(snapshot, { nowMs, source: 'oauth', account });
    } catch (error) {
      return antigravityAccountError(account, error, nowMs);
    }
  }));
  const [local, remote] = await Promise.all([localPromise, remotePromise]);
  const providers = [...remote];
  if (local?.accountKey) observeLocalAccount(local, deps);
  if (!local?.accountKey && rememberedOffered && scope?.sourceDetail !== 'oauth'
    && !providers.some((provider) => provider.accountKey === rememberedOffered.accountKey)) {
    providers.unshift(rememberedLocalProvider(rememberedOffered, null, nowMs));
  }
  if (local?.accountKey) {
    const duplicateIndex = providers.findIndex((provider) => provider.accountKey === local.accountKey);
    if (duplicateIndex >= 0) {
      const existing = providers[duplicateIndex];
      const existingHasGrouped = (existing.windows || []).some((w) => typeof w.windowMinutes === 'number');
      const localHasGrouped = (local.windows || []).some((w) => typeof w.windowMinutes === 'number');
      const localIsHealthy = local.status === 'ok';
      if (localIsHealthy && (localHasGrouped || !existingHasGrouped)) {
        providers.splice(
          duplicateIndex,
          1,
          localHasGrouped && existingHasGrouped ? mergeMissingOAuthGroups(local, existing) : local
        );
      }
    } else {
      providers.unshift(local);
    }
  }
  return providers;
}

module.exports = {
  fetchAntigravityLimits
};

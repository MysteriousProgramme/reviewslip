'use strict';

/**
 * Talking to OpenRouter: the endpoints, the cached model catalogue, and the
 * checks that run before a setting is stored.
 *
 * Both the settings panel and the admin API save the same fields, so the
 * "is this key real, is this slug real" pass lives here rather than in either
 * caller.
 */

const CHAT = 'https://openrouter.ai/api/v1/chat/completions';
const MODELS = 'https://openrouter.ai/api/v1/models';
const KEY_INFO = 'https://openrouter.ai/api/v1/key';

let cache = { at: 0, models: [] };
const CATALOGUE_TTL = 10 * 60_000;

/** The model list, cached — used by the picker and the slug check. */
async function catalogue() {
  if (Date.now() - cache.at < CATALOGUE_TTL) return cache.models;

  try {
    const res = await fetch(MODELS, { signal: AbortSignal.timeout(8_000) });
    if (!res.ok) return cache.models;

    const { data } = await res.json();
    if (!Array.isArray(data)) return cache.models;

    const models = data
      .map((m) => ({ id: m.id, name: m.name || m.id }))
      .sort((a, b) => a.id.localeCompare(b.id));
    cache = { at: Date.now(), models };
    return models;
  } catch {
    // Offline, or OpenRouter is down. Fall back to whatever we last saw.
    return cache.models;
  }
}

/** True only when the catalogue loaded and the slug is definitely absent. */
async function modelMissing(slug) {
  const models = await catalogue();
  return models.length > 0 && !models.some((m) => m.id === slug);
}

/** 'ok' | 'rejected' | 'unreachable' — never throws. */
async function verifyKey(key) {
  try {
    const res = await fetch(KEY_INFO, {
      headers: { Authorization: `Bearer ${key}` },
      signal: AbortSignal.timeout(10_000),
    });
    if (res.ok) return 'ok';
    if (res.status === 401 || res.status === 403) return 'rejected';
    return 'unreachable';
  } catch {
    return 'unreachable';
  }
}

/**
 * Checks a settings patch before it is stored. A key OpenRouter rejects would
 * otherwise surface as a failed generation much later, in front of a guest.
 *
 * @returns {{error?: string, warning?: string}} an error means do not save
 */
async function vet(patch = {}) {
  let warning;

  const key = typeof patch.apiKey === 'string' ? patch.apiKey.trim() : '';
  if (key) {
    const verdict = await verifyKey(key);
    if (verdict === 'rejected') {
      return { error: 'OpenRouter rejected that key. Check it and try again.' };
    }
    if (verdict === 'unreachable') {
      warning = 'Saved, but OpenRouter could not be reached to check the key.';
    }
  }

  const model = typeof patch.model === 'string' ? patch.model.trim() : '';
  if (model && (await modelMissing(model))) {
    warning = `Saved, but "${model}" is not in OpenRouter's catalogue.`;
  }

  return { warning };
}

module.exports = {
  CHAT,
  MODELS,
  KEY_INFO,
  catalogue,
  modelMissing,
  verifyKey,
  vet,
};

'use strict';

const openrouter = require('./openrouter');
const { publicUrl } = require('./tenant');

/**
 * Reading a business's own website through OpenRouter's web_fetch server tool.
 *
 * Lifted out of server.js so the customer API can use it too. It was only ever
 * local to that file because the guest page's settings panel was the sole
 * caller; the panel is gone and the dashboard is the caller now.
 */

/**
 * One call to OpenRouter with its web_fetch server tool attached. The venue
 * details draft and the category draft read the same page the same way; only
 * the prompt and what is made of the answer differ.
 *
 * @returns {{ok: true, content: string}|{ok: false, status: number, error: string}}
 */
async function readWebsite(subscriber, { apiKey, model }, { messages, maxTokens }) {
  try {
    const upstream = await fetch(openrouter.CHAT, {
      method: 'POST',
      headers: openrouterHeaders(apiKey, subscriber),
      body: JSON.stringify({
        model,
        messages,
        // Server-side tool: OpenRouter fetches the page and hands the text to
        // the model, so there is no tool-call loop to run here.
        tools: [{ type: 'openrouter:web_fetch' }],
        max_tokens: maxTokens,
      }),
      signal: AbortSignal.timeout(90_000),
    });

    if (!upstream.ok) {
      const detail = await upstream.text().catch(() => '');
      console.error(
        `OpenRouter web_fetch ${upstream.status}: ${detail.slice(0, 500)}`
      );
      return {
        ok: false,
        status: 502,
        error:
          upstream.status === 404
            ? `"${model}" could not be used for reading a page. Try a model that supports tools.`
            : 'Could not read the website. Try again.',
      };
    }

    const data = await upstream.json();
    return { ok: true, content: data?.choices?.[0]?.message?.content };
  } catch (err) {
    const timedOut = err?.name === 'TimeoutError' || err?.name === 'AbortError';
    console.error('Website read failed:', err);
    return {
      ok: false,
      status: timedOut ? 504 : 502,
      error: timedOut
        ? 'Reading the website took too long. Try again.'
        : 'Could not reach the reader. Check the connection and try again.',
    };
  }
}

function openrouterHeaders(apiKey, subscriber) {
  return {
    Authorization: `Bearer ${apiKey}`,
    'Content-Type': 'application/json',
    'HTTP-Referer': publicUrl(subscriber.slug),
    'X-Title': `${subscriber.name} review helper`,
  };
}

module.exports = { readWebsite, openrouterHeaders };

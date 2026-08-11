'use strict';

require('dotenv').config();

const { pool, ready, query } = require('../db');
const accounts = require('../accounts');
const plans = require('../plans');

/**
 * Create a customer account from the command line, and optionally hand it some
 * venues that already exist.
 *
 * There is no self-serve signup on the website yet, and the first account has
 * to come from somewhere. Once the dashboard exists this stays useful for
 * support: making an account for someone who cannot, or moving a venue between
 * accounts.
 *
 *   node scripts/create-account.js \
 *     --email you@example.com --username YourName1! --password 'a long one' \
 *     --plan agency --venues baanpong
 *
 * Safe to re-run: an email or username that already exists stops the script
 * rather than making a second account. Pass --link-only to skip creation and
 * just move venues onto an existing account.
 */

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg.startsWith('--')) continue;

    const key = arg.slice(2);
    const next = argv[i + 1];
    if (!next || next.startsWith('--')) {
      out[key] = true;
    } else {
      out[key] = next;
      i++;
    }
  }
  return out;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  if (!args.email && !args.username) {
    console.error(
      'Usage: node scripts/create-account.js --email <email> --username <username> --password <password> [--plan starter|pro|enterprise|agency] [--venues slug,slug] [--link-only]'
    );
    process.exitCode = 1;
    return;
  }

  await ready;

  const existing = await accounts.byLogin(args.email || args.username);
  let account;

  if (existing) {
    if (!args['link-only']) {
      console.error(
        `An account already exists for that email or username (id ${existing.id}).`
      );
      console.error('Pass --link-only to attach venues to it instead.');
      process.exitCode = 1;
      return;
    }
    account = accounts.toRecord(existing);
    console.log(`Using existing account ${account.username} <${account.email}>.`);
  } else {
    const plan = args.plan || plans.DEFAULT_PLAN;
    if (!plans.isPlan(plan)) {
      console.error(
        `No such plan "${plan}". One of: ${Object.keys(plans.PLANS).join(', ')}.`
      );
      process.exitCode = 1;
      return;
    }

    account = await accounts.create({
      email: args.email,
      username: args.username,
      password: args.password,
      plan,
    });

    console.log(
      `Created ${account.username} <${account.email}> on ${plans.planFor(account.plan).name}.`
    );
  }

  const slugs = String(args.venues || '')
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);

  if (!slugs.length) {
    console.log('No venues to link.');
    return;
  }

  const owned = await query(
    `UPDATE subscribers
        SET account_id = $1, updated_at = $2
      WHERE slug = ANY($3::text[])
      RETURNING slug`,
    [account.id, new Date().toISOString(), slugs]
  );

  const linked = owned.rows.map((r) => r.slug);
  const missing = slugs.filter((s) => !linked.includes(s));

  for (const slug of linked) console.log(`  linked   ${slug}`);
  for (const slug of missing) console.log(`  no venue ${slug}`);

  // The plan caps venues, but this bypasses the API that enforces it — so say
  // when the result is over the line rather than letting it be discovered in
  // the dashboard later.
  const total = await query(
    'SELECT COUNT(*)::int AS n FROM subscribers WHERE account_id = $1',
    [account.id]
  );
  const plan = plans.planFor(account.plan);
  if (plan.venues !== null && total.rows[0].n > plan.venues) {
    console.warn(
      `\n! ${account.username} now has ${total.rows[0].n} venues but ${plan.name} covers ${plan.venues}.`
    );
  }
}

main()
  .catch((err) => {
    console.error('Failed:', err.message);
    process.exitCode = 1;
  })
  .finally(() => pool.end());

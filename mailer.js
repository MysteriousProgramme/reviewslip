'use strict';

/**
 * Sending mail, through Amazon SES.
 *
 * Off unless configured, and that is the important property. MAIL_FROM and
 * AWS_REGION unset means send() reports that it did nothing and every caller
 * carries on — so this code can ship before SES exists without any of it
 * breaking, and the invitations keep working as links to copy in the meantime.
 *
 * Credentials come from the instance role. There are no AWS keys in this
 * process, in the environment, or on the box, and there is no code path here
 * that would read one; the SDK finds the role by itself. That is a standing
 * rule for this deployment, not a preference.
 *
 * The SDK is required lazily. The review app deploys with `git pull` and a
 * restart — no `npm install` — so a top-level require of a package that is not
 * on the box yet would take the whole service down on the deploy that
 * introduced it, guest pages and all, to add a feature nobody had asked to
 * switch on.
 */

/**
 * The region SES lives in — which is not necessarily the one this box is in.
 *
 * MAIL_REGION first, on purpose. This deployment runs in ap-southeast-7 and
 * sends from eu-west-1, because the WorkMail organisation that owns
 * info@reviewslip.com is there and the domain is already verified against it.
 * Calling that `AWS_REGION` would read as a mistake to the next person to look
 * — the obvious "fix" being to set it to the region the instance reports, which
 * would point SES at an identity that does not exist there and stop every
 * invitation with no change to this file to explain it.
 *
 * AWS_REGION still works as a fallback, for a deployment where the two are the
 * same and the distinction does not arise.
 */
const REGION = String(
  process.env.MAIL_REGION || process.env.AWS_REGION || ''
).trim();

/** e.g. `Reviewslip <info@reviewslip.com>`. Must be an SES-verified identity. */
const FROM = String(process.env.MAIL_FROM || '').trim();

/** Where a reply goes. Falls back to the From address. */
const REPLY_TO = String(process.env.MAIL_REPLY_TO || '').trim() || FROM;

/**
 * Where support notifications land. Falls back to the From address, which is
 * the mailbox this all sends as and therefore one somebody already reads.
 */
const SUPPORT = String(process.env.MAIL_SUPPORT || '').trim() || FROM;

const configured = Boolean(REGION && FROM);

// undefined = not tried yet, null = tried and cannot.
let client;

function transport() {
  if (client !== undefined) return client;

  try {
    // eslint-disable-next-line global-require
    const { SESv2Client } = require('@aws-sdk/client-sesv2');
    client = new SESv2Client({ region: REGION });
  } catch (err) {
    console.error(
      'Mailer: @aws-sdk/client-sesv2 is not installed, so nothing will be sent. ' +
        'Run `npm install` in /opt/reviewslip and restart.',
      err?.message
    );
    client = null;
  }

  return client;
}

/**
 * Send one message.
 *
 * Never throws. Every caller is doing something that matters more than the
 * email — creating an invitation, in the only case there is today — and none of
 * them should fail because SES is in sandbox, or throttling, or not set up.
 *
 * @returns {Promise<{sent: boolean, reason?: string}>}
 */
async function send({ to, subject, text, html }) {
  if (!configured) return { sent: false, reason: 'not configured' };
  if (!to) return { sent: false, reason: 'no recipient' };

  const ses = transport();
  if (!ses) return { sent: false, reason: 'sdk missing' };

  try {
    const { SendEmailCommand } = require('@aws-sdk/client-sesv2');

    await ses.send(
      new SendEmailCommand({
        FromEmailAddress: FROM,
        ReplyToAddresses: [REPLY_TO],
        Destination: { ToAddresses: [to] },
        Content: {
          Simple: {
            Subject: { Data: subject, Charset: 'UTF-8' },
            Body: {
              Text: { Data: text, Charset: 'UTF-8' },
              ...(html ? { Html: { Data: html, Charset: 'UTF-8' } } : {}),
            },
          },
        },
      })
    );

    return { sent: true };
  } catch (err) {
    // Logged with the recipient, because the two failures worth telling apart
    // both look like this from here: SES still in sandbox (which refuses every
    // unverified address, so nothing reaches a real customer) and one address
    // being rejected on its own.
    console.error('Mailer: send to %s failed:', to, err?.name, err?.message);
    return { sent: false, reason: err?.name || 'send failed' };
  }
}

module.exports = { send, configured, FROM, SUPPORT };

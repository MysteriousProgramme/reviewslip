'use strict';

/**
 * Makes the key pair the softphone signs its pushes with, and prints the two
 * lines to add to the review app's .env. Run once per server:
 *
 *   (echo; node scripts/vapid-keys.js) >> .env
 *
 * The leading echo keeps the first key off the end of a last line that has
 * no newline.
 *
 * Changing the pair later unsubscribes every phone: each person turns ringing
 * on again from the phone page.
 */

const webpush = require('web-push');

const { publicKey, privateKey } = webpush.generateVAPIDKeys();
console.log(`VAPID_PUBLIC_KEY=${publicKey}`);
console.log(`VAPID_PRIVATE_KEY=${privateKey}`);

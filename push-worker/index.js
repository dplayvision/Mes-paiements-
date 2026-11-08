'use strict';

const admin = require('firebase-admin');
const webpush = require('web-push');
const crypto = require('node:crypto');

const OWNER = 'pLAvsCmVU1e8SXjy77nNR5DnmpN2';
const BASE = 'https://dplayvision.github.io/Mes-paiements-/';

function cleanSecret(name) {
  return (process.env[name] || '')
    .trim()
    .replace(/^["']|["']$/g, '');
}

const SERVICE_ACCOUNT = cleanSecret('FIREBASE_SERVICE_ACCOUNT');
const VAPID_PUBLIC_KEY = cleanSecret('VAPID_PUBLIC_KEY');
const VAPID_PRIVATE_KEY = cleanSecret('VAPID_PRIVATE_KEY');
const VAPID_SUBJECT =
  cleanSecret('VAPID_SUBJECT') || 'mailto:admin@example.com';

if (!SERVICE_ACCOUNT || !VAPID_PUBLIC_KEY || !VAPID_PRIVATE_KEY) {
  throw new Error('Un secret GitHub est manquant.');
}

console.log('Longueur clé publique VAPID :', VAPID_PUBLIC_KEY.length);
console.log(
  'Format clé publique VAPID :',
  /^[A-Za-z0-9_-]+$/.test(VAPID_PUBLIC_KEY)
);

admin.initializeApp({
  credential: admin.credential.cert(JSON.parse(SERVICE_ACCOUNT))
});

webpush.setVapidDetails(
  VAPID_SUBJECT,
  VAPID_PUBLIC_KEY,
  VAPID_PRIVATE_KEY
);

const db = admin.firestore();

const dateParts = date => {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(date || ''))) return null;

  const [y, m, d] = date.split('-').map(Number);
  const check = new Date(Date.UTC(y, m - 1, d));

  return check.getUTCFullYear() === y &&
    check.getUTCMonth() === m - 1 &&
    check.getUTCDate() === d ? check : null;
};

const ymd = d => d.toISOString().slice(0, 10);

const plusDays = (date, n) => {
  const d = dateParts(date);
  if (!d) return '';

  d.setUTCDate(d.getUTCDate() + n);
  return ymd(d);
};

function addMonthsSafe(date, months) {
  const d = dateParts(date);
  if (!d) return '';

  const year = d.getUTCFullYear();
  const month = d.getUTCMonth();
  const day = d.getUTCDate();

  const total = month + months;
  const y = year + Math.floor(total / 12);
  const m = ((total % 12) + 12) % 12;

  return ymd(new Date(Date.UTC(
    y,
    m,
    Math.min(day, new Date(Date.UTC(y, m + 1, 0)).getUTCDate())
  )));
}

function localDate() {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/Brussels',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  }).formatToParts(new Date());

  const obj = Object.fromEntries(parts.map(p => [p.type, p.value]));

  return `${obj.year}-${obj.month}-${obj.day}`;
}

function reminderKey(type, id, due, offset) {
  return crypto.createHash('sha256')
    .update([type, id, due, offset].join('|'))
    .digest('hex');
}

function collect(root, today) {
  const jobs = [];

  const settings = {
    payments: true,
    domiciliations: true,
    permanentDomiciliations: true,
    warranties: true,
    ...(root.notificationSettings || {})
  };

  const add = (type, id, name, due, offset, url) => {
    if (!dateParts(due) || plusDays(due, -offset) !== today) return;

    jobs.push({
      key: reminderKey(type, id, due, offset),
      title: offset === 7
        ? '🛡️ Garantie bientôt terminée'
        : offset === 3
          ? '📅 Échéance dans 3 jours'
          : '💳 Échéance aujourd’hui',
      body: `${name || 'Élément'} — ${due.split('-').reverse().join('/')}`,
      url,
      tag: reminderKey(type, id, due, offset)
    });
  };

  // PAIEMENTS
  if (settings.payments !== false) for (const p of root.payments || []) {
    for (const i of p.installments || []) {
      if (i.paid === true) continue;

      const id = `${p.id || ''}:${i.id || i.date}`;

      add(
        'payment', id,
        p.name || p.title || p.alias || 'Paiement',
        i.date, 3, BASE
      );

      add(
        'payment', id,
        p.name || p.title || p.alias || 'Paiement',
        i.date, 0, BASE
      );
    }
  }

  // DOMICILIATIONS
  if (settings.domiciliations !== false) for (const d of root.domiciliations || []) {
    const count = Math.min(1200, Math.max(0, Number(d.months) || 0));
    const paid = new Set((d.monthsPaid || []).map(Number));

    for (let i = 0; i < count; i++) {
      if (paid.has(i + 1)) continue;

      const due = addMonthsSafe(d.startDate, i);

      add(
        'dom', `${d.id}:${i + 1}`,
        d.alias || d.beneficiary || 'Domiciliation',
        due, 3, BASE
      );

      add(
        'dom', `${d.id}:${i + 1}`,
        d.alias || d.beneficiary || 'Domiciliation',
        due, 0, BASE
      );
    }
  }

  // DOMICILIATIONS PERMANENTES
  if (settings.permanentDomiciliations !== false) for (const d of root.permanentDomiciliations || []) {
    const freq = [1, 3, 6, 12].includes(Number(d.frequency))
      ? Number(d.frequency)
      : 1;

    const start = dateParts(d.startDate);
    if (!start) continue;

    const paid = new Set((d.monthsPaid || []).map(String));

    for (let i = 0; i < 1200; i += freq) {
      const due = addMonthsSafe(d.startDate, i);

      if (due > plusDays(today, 3)) break;

      const key = due.slice(0, 7);
      if (paid.has(key)) continue;

      add(
        'permanent', `${d.id}:${key}`,
        d.alias || d.beneficiary || 'Prélèvement permanent',
        due, 3, BASE
      );

      add(
        'permanent', `${d.id}:${key}`,
        d.alias || d.beneficiary || 'Prélèvement permanent',
        due, 0, BASE
      );
    }
  }

  // GARANTIES APPAREILS
  if (settings.warranties !== false) for (const c of root.contracts || []) {
    if (c.category !== 'Garantie appareil') continue;

    const end = c.warrantyEnd || c.warrantyCustomEnd;

    add(
      'warranty',
      c.id,
      c.name || 'Appareil',
      end,
      7,
      BASE + 'contrats.html?view=warranties&warranty=' +
        encodeURIComponent(c.id || '')
    );
  }

  return jobs;
}

async function main() {
  const today = localDate();

  const rootRef = db.collection('users').doc(OWNER);
  const rootSnap = await rootRef.get();

  if (!rootSnap.exists) {
    throw new Error('Document utilisateur introuvable');
  }

  const subsRef = rootRef
    .collection('apps')
    .doc('mes-paiements')
    .collection('pushSubscriptions');

  const subs = (await subsRef.get()).docs.filter(d =>
    d.data().enabled !== false &&
    d.data().subscription?.endpoint
  );

  const jobs = collect(rootSnap.data(), today);

  console.log(
    `Date Bruxelles ${today}, ${jobs.length} rappel(s), ${subs.length} appareil(s).`
  );

  if (!subs.length) return;

  const sentRef = rootRef
    .collection('apps')
    .doc('mes-paiements')
    .collection('sentReminders');

  for (const job of jobs) {
    const ref = sentRef.doc(job.key);
    const already = await ref.get();

    if (already.exists) continue;

    let successes = 0;

    for (const sub of subs) {
      try {
        await webpush.sendNotification(
          sub.data().subscription,
          JSON.stringify(job),
          { TTL: 86400 }
        );

        successes++;

      } catch (e) {
        console.error(
          'Envoi impossible',
          sub.id,
          e.statusCode || '',
          e.message
        );

        if ([404, 410].includes(e.statusCode)) {
          await sub.ref.delete();
        }
      }
    }

    // Ne pas marquer envoyé si aucun appareil n'a reçu le push.
    if (successes) {
      await ref.create({
        sentAt: admin.firestore.FieldValue.serverTimestamp(),
        date: today,
        successes,
        kind: job.title
      });
    }
  }
}

main().catch(e => {
  console.error(e);
  process.exitCode = 1;
});
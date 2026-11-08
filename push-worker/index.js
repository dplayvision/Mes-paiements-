'use strict';

const admin = require('firebase-admin');
const webpush = require('web-push');
const crypto = require('node:crypto');

const OWNER = (process.env.OWNER_UID || 'pLAvsCmVU1e8SXjy77nNR5DnmpN2').trim();
const BASE = 'https://dplayvision.github.io/Mes-paiements-/';

function cleanSecret(name) {
  return (process.env[name] || '').trim().replace(/^['"]|['"]$/g, '');
}

const SERVICE_ACCOUNT = cleanSecret('FIREBASE_SERVICE_ACCOUNT');
const VAPID_PUBLIC_KEY = cleanSecret('VAPID_PUBLIC_KEY');
const VAPID_PRIVATE_KEY = cleanSecret('VAPID_PRIVATE_KEY');
const VAPID_SUBJECT = cleanSecret('VAPID_SUBJECT') || 'mailto:admin@example.com';

if (!OWNER || !SERVICE_ACCOUNT || !VAPID_PUBLIC_KEY || !VAPID_PRIVATE_KEY) {
  throw new Error('Un paramètre requis (OWNER_UID ou secret Firebase/VAPID) est manquant.');
}

console.log('Longueur clé publique VAPID :', VAPID_PUBLIC_KEY.length);
console.log('Format clé publique VAPID :', /^[A-Za-z0-9_-]+$/.test(VAPID_PUBLIC_KEY));

admin.initializeApp({ credential: admin.credential.cert(JSON.parse(SERVICE_ACCOUNT)) });
webpush.setVapidDetails(VAPID_SUBJECT, VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY);
const db = admin.firestore();

const dateParts = date => {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(date || ''))) return null;
  const [y, m, d] = date.split('-').map(Number);
  const check = new Date(Date.UTC(y, m - 1, d));
  return check.getUTCFullYear() === y && check.getUTCMonth() === m - 1 && check.getUTCDate() === d ? check : null;
};
const ymd = d => d.toISOString().slice(0, 10);
const plusDays = (date, n) => { const d = dateParts(date); if (!d) return ''; d.setUTCDate(d.getUTCDate() + n); return ymd(d); };
function addMonthsSafe(date, months) {
  const d = dateParts(date); if (!d) return '';
  const year=d.getUTCFullYear(), month=d.getUTCMonth(), day=d.getUTCDate();
  const total=month+months, y=year+Math.floor(total/12), m=((total%12)+12)%12;
  return ymd(new Date(Date.UTC(y,m,Math.min(day,new Date(Date.UTC(y,m+1,0)).getUTCDate()))));
}
function localDate() {
  const parts = new Intl.DateTimeFormat('en-CA',{timeZone:'Europe/Brussels',year:'numeric',month:'2-digit',day:'2-digit'}).formatToParts(new Date());
  const obj=Object.fromEntries(parts.map(p=>[p.type,p.value])); return `${obj.year}-${obj.month}-${obj.day}`;
}
function reminderKey(type,id,due,offset) { return crypto.createHash('sha256').update([type,id,due,offset].join('|')).digest('hex'); }

function stableReminderValue(value) {
  if (Array.isArray(value)) return value.map(stableReminderValue);
  if (value && typeof value === 'object') {
    const out = {};
    for (const key of Object.keys(value).sort()) {
      // Ignore synchronization bookkeeping: it is not a user-visible edit.
      if (['_syncUpdatedAt','syncUpdatedAt','updatedAt','createdAt','lastSyncedAt'].includes(key)) continue;
      out[key] = stableReminderValue(value[key]);
    }
    return out;
  }
  return value;
}
function paymentFingerprint(payment, installment) {
  const payload = {
    payment: {...payment, installments:undefined},
    installment
  };
  return crypto.createHash('sha256').update(JSON.stringify(stableReminderValue(payload))).digest('hex');
}
function paymentStateId(paymentId, installmentId) {
  return crypto.createHash('sha256').update([String(paymentId),String(installmentId)].join('|')).digest('hex');
}
function collect(root,today) {
  const jobs=[];
  const settings={payments:true,domiciliations:true,permanentDomiciliations:true,warranties:true,...(root.notificationSettings||{})};
  const add=(type,id,name,due,offset,url)=>{
    if(!dateParts(due)||plusDays(due,-offset)!==today)return;
    const key=reminderKey(type,id,due,offset);
    jobs.push({key,title:offset===7?'🛡️ Garantie bientôt terminée':offset===3?'📅 Échéance dans 3 jours':'💳 Échéance aujourd’hui',body:`${name||'Élément'} — ${due.split('-').reverse().join('/')}`,url,tag:key});
  };
  if(settings.payments!==false) for(const p of root.payments||[]) for(const i of p.installments||[]) {
    if(i.paid===true)continue; const id=`${p.id||''}:${i.id||i.date}`;
    add('payment',id,p.name||p.title||p.alias||'Paiement',i.date,3,BASE);
    add('payment',id,p.name||p.title||p.alias||'Paiement',i.date,0,BASE);
  }
  if(settings.domiciliations!==false) for(const d of root.domiciliations||[]) {
    const count=Math.min(1200,Math.max(0,Number(d.months)||0)),paid=new Set((d.monthsPaid||[]).map(Number));
    for(let i=0;i<count;i++){if(paid.has(i+1))continue;const due=addMonthsSafe(d.startDate,i);const id=`${d.id}:${i+1}`;add('dom',id,d.alias||d.beneficiary||'Domiciliation',due,3,BASE);add('dom',id,d.alias||d.beneficiary||'Domiciliation',due,0,BASE);}
  }
  if(settings.permanentDomiciliations!==false) for(const d of root.permanentDomiciliations||[]) {
    const freq=[1,3,6,12].includes(Number(d.frequency))?Number(d.frequency):1,start=dateParts(d.startDate);if(!start)continue;
    const paid=new Set((d.monthsPaid||[]).map(String));
    for(let i=0;i<1200;i+=freq){const due=addMonthsSafe(d.startDate,i);if(due>plusDays(today,3))break;const key=due.slice(0,7);if(paid.has(key))continue;const id=`${d.id}:${key}`;add('permanent',id,d.alias||d.beneficiary||'Prélèvement permanent',due,3,BASE);add('permanent',id,d.alias||d.beneficiary||'Prélèvement permanent',due,0,BASE);}
  }
  if(settings.warranties!==false) for(const c of root.contracts||[]) if(c.category==='Garantie appareil') {
    const end=c.warrantyEnd||c.warrantyCustomEnd;
    add('warranty',c.id,c.name||'Appareil',end,7,BASE+'contrats.html?view=warranties&warranty='+encodeURIComponent(c.id||''));
  }
  return jobs;
}

async function readCollection(appRef,name,fallback) {
  const snap=await appRef.collection(name).get();
  return snap.empty?(Array.isArray(fallback)?fallback:[]):snap.docs.map(d=>({id:d.id,...d.data()}));
}

async function sendJob(job,subs,sentRef,today) {
  const ref=sentRef.doc(job.key);
  // Persist progress per device: a later 5-minute run retries only devices not yet successful.
  const stateSnap=await ref.get();
  const state=stateSnap.exists?(stateSnap.data()||{}):{};
  if(state.complete===true){console.log(`Déjà envoyé : ${job.title} (${job.key.slice(0,10)}).`);return;}
  const delivered=new Set(Array.isArray(state.deliveredDeviceIds)?state.deliveredDeviceIds.map(String):[]);
  let success=0,failed=0,skipped=0;
  for(const sub of subs) {
    const deviceId=String(sub.id);
    if(delivered.has(deviceId)){skipped++;continue;}
    try {
      const payload=Object.fromEntries(Object.entries(job).filter(([key])=>!key.startsWith('_')));
      const result=await webpush.sendNotification(sub.data().subscription,JSON.stringify(payload),{TTL:86400});
      delivered.add(deviceId);success++;
      await ref.set({date:today,kind:job.title,deliveredDeviceIds:[...delivered],lastAttemptAt:admin.firestore.FieldValue.serverTimestamp(),lastStatusCode:result?.statusCode||201,complete:false},{merge:true});
      console.log(`Push accepté par le service pour l'appareil ${deviceId}.`);
    } catch(e) {
      failed++;
      console.error(`Échec appareil ${deviceId} [${e.statusCode||'sans code'}] : ${e.message||e}`);
      if([404,410].includes(Number(e.statusCode))) {
        await sub.ref.delete();
        console.log(`Inscription expirée supprimée : ${deviceId}.`);
      }
    }
  }
  const activeIds=subs.filter(s=>s.data().enabled!==false&&s.data().subscription?.endpoint).map(s=>String(s.id)).filter(id=>!delivered.has(id));
  const complete=activeIds.length===0;
  await ref.set({date:today,kind:job.title,deliveredDeviceIds:[...delivered],successesTotal:delivered.size,failedLastAttempt:failed,complete,sentAt:complete?admin.firestore.FieldValue.serverTimestamp():null,lastAttemptAt:admin.firestore.FieldValue.serverTimestamp()},{merge:true});
  console.log(`Bilan ${job.key.slice(0,10)} : ${success} nouvel(aux) succès, ${skipped} déjà servis, ${failed} échec(s), ${complete?'terminé':'à réessayer'}.`);
}


async function collectChangedPaymentJobs(payments, today, stateRef) {
  const jobs = [];
  const todayDate = dateParts(today);
  const windowEnd = plusDays(today, 3);
  for (const payment of payments || []) {
    for (const installment of payment.installments || []) {
      if (installment.paid === true) continue;
      const due = installment.date;
      if (!dateParts(due)) continue;
      const paymentId = String(payment.id || '');
      const installmentId = String(installment.id || installment.date || '');
      const stateDoc = stateRef.doc(paymentStateId(paymentId, installmentId));
      const fingerprint = paymentFingerprint(payment, installment);
      const stateSnap = await stateDoc.get();
      if (!stateSnap.exists) {
        // First run after enabling change detection: establish a baseline without
        // sending duplicate notifications for existing payments.
        await stateDoc.set({paymentId, installmentId, fingerprint, initializedAt:admin.firestore.FieldValue.serverTimestamp()});
        continue;
      }
      const previous = stateSnap.data() || {};
      if (previous.fingerprint === fingerprint) continue;

      // Always refresh the baseline outside the reminder window, so an old edit
      // does not unexpectedly trigger a notification days or weeks later.
      if (due >= today && due <= windowEnd) {
        const id = `${paymentId}:${installmentId}`;
        const key = crypto.createHash('sha256').update(['payment-change',id,due,fingerprint].join('|')).digest('hex');
        jobs.push({
          key,
          title:'🔔 Paiement modifié',
          body:`${payment.name||payment.title||payment.alias||'Paiement'} — ${due.split('-').reverse().join('/')} — montant : ${Number(installment.amount ?? payment.amount ?? 0).toLocaleString('fr-BE',{style:'currency',currency:'EUR'})}`,
          url:BASE,
          tag:key,
          _paymentStateRef:stateDoc,
          _fingerprint:fingerprint
        });
      } else {
        await stateDoc.set({fingerprint,updatedAt:admin.firestore.FieldValue.serverTimestamp()},{merge:true});
      }
    }
  }
  return jobs;
}
async function main() {
  const today=localDate(),rootRef=db.collection('users').doc(OWNER),rootSnap=await rootRef.get();
  if(!rootSnap.exists)throw new Error('Document utilisateur introuvable');
  const rootData=rootSnap.data()||{},appRef=rootRef.collection('apps').doc('mes-paiements');
  const subs=(await appRef.collection('pushSubscriptions').get()).docs.filter(d=>d.data().enabled!==false&&d.data().subscription?.endpoint);
  const [payments,domiciliations,permanentDomiciliations,contracts]=await Promise.all([
    readCollection(appRef,'payments',rootData.payments),readCollection(appRef,'domiciliations',rootData.domiciliations),
    readCollection(appRef,'permanentDomiciliations',rootData.permanentDomiciliations),readCollection(appRef,'contracts',rootData.contracts)
  ]);
  const deletedPayments=new Set((rootData.deletedPaymentIds||[]).map(String)),deletedDoms=new Set((rootData.deletedDomiciliationIds||[]).map(String));
  const deletedPermanent=new Set((rootData.deletedPermanentDomiciliationIds||[]).map(String)),deletedContracts=new Set((rootData.deletedContractIds||[]).map(String));
  const deletedInstallments=new Set((rootData.deletedInstallmentIds||[]).map(String));
  const livePayments=payments.filter(p=>!deletedPayments.has(String(p.id))).map(p=>({...p,installments:(p.installments||[]).filter(i=>!deletedInstallments.has(String(p.id)+'::'+String(i.id)))}));
  const jobs=collect({...rootData,payments:livePayments,domiciliations:domiciliations.filter(d=>!deletedDoms.has(String(d.id))),permanentDomiciliations:permanentDomiciliations.filter(d=>!deletedPermanent.has(String(d.id))),contracts:contracts.filter(c=>!deletedContracts.has(String(c.id)))},today);
  const paymentStateRef=appRef.collection('paymentReminderState');
  const changedPaymentJobs=await collectChangedPaymentJobs(livePayments,today,paymentStateRef);
  jobs.push(...changedPaymentJobs);
  console.log(`Date Bruxelles ${today}, ${jobs.length} rappel(s) dont ${changedPaymentJobs.length} modification(s) de paiement, ${subs.length} appareil(s) actif(s).`);
  if(!subs.length){console.log('Aucun appareil actif : aucun rappel envoyé.');return;}
  const sentRef=appRef.collection('sentReminders');
  for(const job of jobs) {
    await sendJob(job,subs,sentRef,today);
    if(job._paymentStateRef) {
      const delivery=await sentRef.doc(job.key).get();
      if(delivery.exists && delivery.data()?.complete===true) {
        await job._paymentStateRef.set({fingerprint:job._fingerprint,updatedAt:admin.firestore.FieldValue.serverTimestamp()},{merge:true});
      }
    }
  }
}
main().catch(e=>{console.error('Échec du worker :',e);process.exitCode=1;});

/* Mes paiements — Notifications automatiques */
(() => {
  'use strict';

  const VAPID_PUBLIC_KEY = 'BAeoLtHHJ81faM7_FztvYXCRSHUg0q45giOlssvcO7n0PEpx4hLOtsaBATnKrIFTUDKlfTAe4NMDOckUGtusy_I';
  const OWNER_UID = 'pLAvsCmVU1e8SXjy77nNR5DnmpN2';
  const APP = 'mes-paiements';

  const label = document.createElement('div');
  label.style.cssText =
    'background:white;border-radius:14px;padding:14px;margin:14px auto;max-width:700px;font:14px -apple-system,BlinkMacSystemFont,sans-serif;box-shadow:0 2px 8px #0001';

  label.innerHTML = `
    <strong>🔔 Notifications automatiques</strong>
    <p id="pushState">Vérification…</p>
    <button type="button" id="pushEnable"
      style="background:#007aff;color:white;border:0;border-radius:10px;padding:12px;width:100%;font-weight:700">
      Activer les notifications
    </button>
  `;

  const mount = document.querySelector('.container')
    || document.querySelector('main')
    || document.body;

  mount.insertBefore(label, mount.firstChild);

  const state = label.querySelector('#pushState');
  const button = label.querySelector('#pushEnable');

  const say = message => {
    state.textContent = message;
  };

  const supported =
    'serviceWorker' in navigator &&
    'PushManager' in window &&
    'Notification' in window;

  function b64ToBytes(value) {
    const padding = '='.repeat((4 - value.length % 4) % 4);
    const raw = atob(
      (value + padding).replace(/-/g, '+').replace(/_/g, '/')
    );

    return Uint8Array.from(raw, c => c.charCodeAt(0));
  }

  async function register() {
    return navigator.serviceWorker.register(
      './firebase-messaging-sw.js',
      { scope: './' }
    );
  }

  async function getUser() {
    if (!window.firebase || !firebase.auth) {
      throw new Error('Firebase indisponible.');
    }

    const auth = firebase.auth();

    const user = auth.currentUser ||
      await new Promise(resolve => {
        const unsubscribe = auth.onAuthStateChanged(u => {
          unsubscribe();
          resolve(u);
        });
      });

    if (!user || user.uid !== OWNER_UID) {
      throw new Error('Connecte-toi au compte Google autorisé.');
    }

    return user;
  }

  async function saveSubscription(sub) {
    const user = await getUser();

    const bytes = new TextEncoder().encode(sub.endpoint);
    const digest = await crypto.subtle.digest('SHA-256', bytes);

    const deviceId = Array.from(new Uint8Array(digest))
      .map(b => b.toString(16).padStart(2, '0'))
      .join('');

    const ref = firebase.firestore()
      .collection('users')
      .doc(user.uid)
      .collection('apps')
      .doc(APP)
      .collection('pushSubscriptions')
      .doc(deviceId);

    await ref.set({
      subscription: sub.toJSON(),
      enabled: true,
      updatedAt: Date.now(),
      userAgent: navigator.userAgent
    }, { merge: true });
  }

  async function refresh() {
    if (!supported) {
      button.disabled = true;
      say('Ouvre le site depuis son icône sur l’écran d’accueil de ton iPhone.');
      return;
    }

    try {
      const reg = await register();
      const existing = await reg.pushManager.getSubscription();

      if (existing && Notification.permission === 'granted') {
        await saveSubscription(existing);
        say('✅ Notifications activées sur cet appareil.');
        button.textContent = 'Réenregistrer cet appareil';
      } else {
        say('Appuie sur le bouton pour activer les rappels.');
      }
    } catch (e) {
      say('Connexion nécessaire : ' + e.message);
    }
  }

  button.addEventListener('click', async () => {
    button.disabled = true;

    try {
      if (!supported) {
        throw new Error('Notifications Web Push indisponibles.');
      }

      await getUser();

      const permission = await Notification.requestPermission();

      if (permission !== 'granted') {
        throw new Error('Autorisation des notifications refusée.');
      }

      const reg = await register();

      const sub = await reg.pushManager.getSubscription()
        || await reg.pushManager.subscribe({
          userVisibleOnly: true,
          applicationServerKey: b64ToBytes(VAPID_PUBLIC_KEY)
        });

      await saveSubscription(sub);

      say('✅ Notifications activées et enregistrées dans Firebase.');
      button.textContent = 'Réenregistrer cet appareil';

    } catch (e) {
      say('❌ ' + e.message);
    } finally {
      button.disabled = false;
    }
  });

  refresh();
})();

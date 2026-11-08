import * as webpush from "web-push";

// Ключи для Web Push: npm --workspace server run vapid → вписать в .env (или в Environment на Render).
const k = webpush.generateVAPIDKeys();
console.log(`VAPID_PUBLIC_KEY=${k.publicKey}\nVAPID_PRIVATE_KEY=${k.privateKey}\nVAPID_SUBJECT=mailto:you@example.com`);

// Decrypt WorkBuddy auth.info accessToken envelope (offline)
// key = sha256(atRestSecretKey-string), AES-256-GCM, AAD candidates
const crypto = require('crypto');
const fs = require('fs');

const SECRET = process.env.WB_SECRET || 'Sik9U5aXhCdwTVEwsEySDOmDoB9r9ntFxHF1fst9LQI=';
const AUTH_FILE = 'C:/Users/123456/AppData/Local/CodeBuddyExtension/Data/Public/auth/workbuddy-desktop.info';

const info = JSON.parse(fs.readFileSync(AUTH_FILE, 'utf8'));
const env = JSON.parse(Buffer.from(info.auth.accessToken.envelope, 'base64').toString('utf8')); // {suite:1,keyId,nonce,authTag,ciphertext}
const key = crypto.createHash('sha256').update(SECRET).digest();

const purpose = 'workbuddy-auth-session';
const resourceId = 'auth/' + require('path').basename(AUTH_FILE);
const aads = [
  JSON.stringify({ purpose, resourceId }),
  JSON.stringify({ purpose, resourceId, suite: 1 }),
  JSON.stringify({ suite: 1, purpose, resourceId }),
  resourceId,
  purpose,
  JSON.stringify({ context: { purpose, resourceId } }),
];

for (const aad of aads) {
  try {
    const d = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(env.nonce, 'base64'), { authTagLength: 16 });
    d.setAAD(Buffer.from(aad, 'utf8'));
    d.setAuthTag(Buffer.from(env.authTag, 'base64'));
    const pt = Buffer.concat([d.update(Buffer.from(env.ciphertext, 'base64')), d.final()]);
    console.log('AAD OK:', aad);
    console.log('PLAINTEXT:', pt.toString('utf8').slice(0, 2000));
    process.exit(0);
  } catch (e) { console.log('fail:', aad.slice(0, 60), e.message); }
}
console.log('ALL AAD FAILED');

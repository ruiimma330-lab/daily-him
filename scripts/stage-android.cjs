// Internal build step: accepts only an apksigner-verified release from build-android.sh.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const root = path.resolve(__dirname, '..');
const [apk, verification] = process.argv.slice(2);
const output = fs.readFileSync(verification, 'utf8');
const digest = output.match(/^Signer #1 certificate SHA-256 digest: ([a-f0-9]{64})$/mi);
if (!digest) throw new Error('Missing signer SHA-256 certificate fingerprint');
const fingerprint = digest[1].toUpperCase().match(/../g).join(':');
const binary = fs.readFileSync(apk);
if (binary[0] !== 0x50 || binary[1] !== 0x4b) throw new Error('Not an APK/ZIP');
const version = JSON.parse(fs.readFileSync(path.join(root, 'android/app/build/outputs/apk/release/output-metadata.json'), 'utf8')).elements[0].versionName;
const info = {
  available: true, version, bytes: binary.length,
  sha256: crypto.createHash('sha256').update(binary).digest('hex'),
  certificateSha256: fingerprint,
};
const statements = [{
  relation: ['delegate_permission/common.handle_all_urls'],
  target: { namespace: 'android_app', package_name: 'com.dailyhim.app', sha256_cert_fingerprints: [fingerprint] },
}];
fs.copyFileSync(apk, path.join(root, 'public/downloads/daily-him.apk'));
fs.writeFileSync(path.join(root, 'public/.well-known/assetlinks.json'), JSON.stringify(statements, null, 2) + '\n');
fs.writeFileSync(path.join(root, 'public/downloads/android.json'), JSON.stringify(info, null, 2) + '\n');
console.log('已生成 /downloads/daily-him.apk；证书 SHA-256: ' + fingerprint);

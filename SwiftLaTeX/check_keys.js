const fs = require('fs');
const zh = JSON.parse(fs.readFileSync('lang/zh.json', 'utf8'));
const used = fs.readFileSync('/tmp/used_keys.txt', 'utf8').trim().split('\n');
const missing = used.filter(k => zh[k] === undefined);
if (missing.length) {
  console.log('Missing (' + missing.length + '):');
  missing.forEach(k => console.log('  ' + k));
} else {
  console.log('All ' + used.length + ' JS i18n keys have translations!');
}

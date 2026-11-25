import test from 'node:test';
import assert from 'node:assert/strict';
import {existsSync,readFileSync} from 'node:fs';
const p='./public/';
test('all PWA assets exist',()=>{
 for(const f of ['index.html','style.css','app.js','voice.js','manifest.webmanifest','assets/orb-texture.webp'])assert.ok(existsSync(p+f),f);
});
test('browser bundle does not contain private credentials',()=>{
 const bundle=readFileSync(p+'voice.js','utf8')+readFileSync(p+'app.js','utf8');
 assert.ok(!bundle.includes('xi-api-key'));assert.ok(!bundle.includes('N8N_AUTH_HEADER_VALUE'));
 assert.ok(!bundle.includes('/rest/1/'));
});

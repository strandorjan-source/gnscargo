'use strict';
// Fail the Vercel build before publishing files if a required regression test fails.
const fs=require('node:fs'),path=require('node:path'),{spawnSync}=require('node:child_process');
const root=path.resolve(__dirname,'..');
for(const test of ['customer-pricing.cjs','carrier-pricing.cjs','invoice-diesel-report.cjs','admin-users.cjs','verify.cjs','operations.cjs']){
  const result=spawnSync(process.execPath,[path.join(root,'tests',test)],{cwd:root,stdio:'inherit',timeout:120000});
  if(result.error||result.status!==0){console.error('Release blocked:',test);process.exit(1);}
}
const output=path.join(root,'public');fs.rmSync(output,{recursive:true,force:true});fs.mkdirSync(output,{recursive:true});
const files=['index.html','index-new.html','app.html','app-fixed.html','admin.html','signup.html','signup-success.html','carrier-documents.html','gns-logo.jpg','gns-logo.png','admin-users.js','order-entry.js','control-tower.js','control-tower.css','carrier-register.js','location-register.js','transport-documents.js','send-order.js','edi-order.js','capacity-order.js','capacity-tab.js','cmr.js','operations.js','operations.css','document-upload.js','carrier-documents.js'];
for(const file of files)fs.copyFileSync(path.join(root,file),path.join(output,file));
fs.mkdirSync(path.join(output,'vendor'));
fs.copyFileSync(path.join(root,'vendor/exceljs-4.4.0.min.js'),path.join(output,'vendor/exceljs-4.4.0.min.js'));
fs.copyFileSync(path.join(root,'tests/node_modules/jspdf/dist/jspdf.umd.min.js'),path.join(output,'vendor/jspdf-4.2.1.umd.min.js'));
fs.writeFileSync(path.join(output,'release.json'),JSON.stringify({release:'carrier-diesel-20261008',commit:process.env.VERCEL_GIT_COMMIT_SHA||process.env.GITHUB_SHA||'local',checks:'passed'})+'\n');
console.log('PASS: release gate; public output includes only allowlisted application assets.');

'use strict';
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const {canonical,verifiedRelease}=require('./app-updater.cjs');
async function signRelease(archive,key,version,destination,gitMetadata={}){
 const hash=crypto.createHash('sha256');for await(const part of fs.createReadStream(archive))hash.update(part);
 const release={version,url:`https://github.com/MREASENTO/CellStation/releases/download/v${version}/CellStation-v${version}-win64.zip`,sha256:hash.digest('hex'),size:fs.statSync(archive).size,publishedAt:new Date().toISOString(),...gitMetadata};
 const document={release,signature:crypto.sign(null,Buffer.from(canonical(release)),key).toString('base64')};verifiedRelease(document,require('./release-config.json'));
 fs.mkdirSync(path.dirname(destination),{recursive:true});fs.writeFileSync(destination,JSON.stringify(document,null,2));fs.writeFileSync(archive.replace(/\.zip$/,'.sha256.txt'),release.sha256+'  '+path.basename(archive)+'\n');return document;
}
if(require.main===module){const [archive,destination,keyFile,gitFile]=process.argv.slice(2),key=keyFile&&keyFile!=='--env-key'?fs.readFileSync(keyFile):process.env.CELLSTATION_UPDATE_SIGNING_KEY;const version=require('./package.json').version;signRelease(archive,key,version,destination,gitFile?JSON.parse(fs.readFileSync(gitFile,'utf8')):{}).then(()=>console.log('SIGNED_RELEASE_MANIFEST_READY')).catch(e=>{console.error(e.message);process.exitCode=1;});}
module.exports={signRelease};

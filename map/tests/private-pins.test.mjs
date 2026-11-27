import test from 'node:test';
import assert from 'node:assert/strict';
await import('../public/private-pins.js');
const {newKeyPair,receiverCode,recipientKey,seal,unseal,protectKeyPair,openVault}=globalThis.NoticoinPrivatePins;

test('closed pin codes protect all content and can be opened only by the addressed profile',async()=>{
 const [receiver,other]=await Promise.all([newKeyPair(),newKeyPair()]);
 const now=Date.now();
 const pin={
  id:crypto.randomUUID(),title:'Private reading room',body:'Bring a book 📚',category:'place',
  lat:-33.868813,lng:151.209298,createdAt:now,expiresAt:now+7*86400000,venueName:'Meeting point'
 };
 assert.equal(receiver.privateKey.extractable,false);
 const publicCode=await receiverCode(receiver.publicKey);
 assert.match(publicCode,/^noti-recipient-v1\./);
 const publicKey=await recipientKey(publicCode);
 const share=await seal(pin,publicKey);
 assert.match(share,/^noti-pin-v1\./);
 const contentRow=Buffer.from(share.slice('noti-pin-v1.'.length),'base64url').toString('utf8');
 for(const item of [pin.title,pin.body,pin.lng,pin.venueName,pin.id])assert.ok(!contentRow.includes(String(item)));
 assert.notEqual(await seal(pin,publicKey),share);
 assert.deepEqual(await unseal(share,receiver.privateKey),pin);
 await assert.rejects(unseal(share,other.privateKey));
 const flipped=share.slice(0,600)+(share[600]==='A'?'B':'A')+share.slice(601);
 await assert.rejects(unseal(flipped,receiver.privateKey));
 await assert.rejects(recipientKey('\x6b\x6f\x6b\x6f-recipient-v1.foo'));
 const legacyKey=await recipientKey(publicCode.replace('noti-','\x6b\x6f\x6b\x6f-'));
 assert.deepEqual(await unseal(await seal(pin,legacyKey),receiver.privateKey),pin);
});

test('a copied vault requires its passphrase and rejects a substituted public key',async()=>{
 const [pair,other]=await Promise.all([newKeyPair(true),newKeyPair()]);
 const phrase='fixture-only long passphrase!';
 const vault=await protectKeyPair(pair,phrase);
 assert.equal(vault.salt.length,16);
 assert.equal(vault.iv.length,12);
 assert.ok(!Object.values(vault).some(value=>value instanceof CryptoKey));
 assert.ok(!JSON.stringify(vault).includes(phrase));
 await assert.rejects(openVault(vault,'different fixture passphrase'));
 await assert.rejects(openVault({...vault,publicCode:await receiverCode(other.publicKey)},phrase));
 const restored=await openVault(vault,phrase);
 assert.equal(restored.privateKey.extractable,false);
 const now=Date.now();
 const pin={id:crypto.randomUUID(),title:'Protected pin',body:'Vault test',category:'message',lat:1,lng:2,createdAt:now,expiresAt:now+7*86400000};
 assert.deepEqual(await unseal(await seal(pin,restored.publicKey),restored.privateKey),pin);
});
test('shared map notes bind their private text and donation description to the note and recipient',async()=>{
 const {newKeyPair,sealNote,openNote,receiverCode,recipientFingerprint}=globalThis.NoticoinPrivatePins;
 const [author,buyer]=await Promise.all([newKeyPair(),newKeyPair()]);
 const note={id:crypto.randomUUID(),body:'An encrypted message at this place',donationNote:'Funding for maintenance'};
 const published=await sealNote(note,author.publicKey);
 assert.ok(!published.includes(note.body)&&!published.includes(note.donationNote));
 assert.deepEqual(await openNote(note.id,published,author.privateKey),note);
 await assert.rejects(openNote(note.id,published,buyer.privateKey));
 const delivered=await sealNote(await openNote(note.id,published,author.privateKey),buyer.publicKey);
 assert.deepEqual(await openNote(note.id,delivered,buyer.privateKey),note);
 await assert.rejects(openNote(note.id,delivered,author.privateKey));
 await assert.rejects(openNote(crypto.randomUUID(),delivered,buyer.privateKey));
 const mutated=delivered.slice(0,-12)+(delivered.at(-12)==='A'?'B':'A')+delivered.slice(-11);
 await assert.rejects(openNote(note.id,mutated,buyer.privateKey));
 assert.notEqual(await recipientFingerprint(await receiverCode(author.publicKey)),await recipientFingerprint(await receiverCode(buyer.publicKey)));
});

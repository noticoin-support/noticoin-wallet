import {test} from 'node:test';
import assert from 'node:assert/strict';
import {parseExact,digestAuthorization,localEndpoint} from '../rpc.mjs';
test('uint64 money survives RPC JSON exactly',()=>{
  const data=parseExact('{"amount":18446744073709551615,"height":10,"amounts":[9007199254740993]}');
  assert.equal(data.amount,'18446744073709551615');assert.equal(data.amounts[0],'9007199254740993');assert.equal(data.height,10);
});
test('Digest matches the standard RFC 2617 auth example',()=>{
  const value=digestAuthorization('Digest realm="testrealm@host.com", qop="auth,auth-int", nonce="dcd98b7102dd2f0e8b11d0f600bfb0c093", opaque="5ccc069c403ebaf9f0171e9517f40e41"',{username:'Mufasa',password:'Circle Of Life',method:'GET',uri:'/dir/index.html',cnonce:'0a4f113b'});
  assert.match(value,/response="6629fae49393a05397450978507c4ef1"/);
});
test('wallet endpoints cannot send credentials to a remote server',()=>{
  assert.equal(localEndpoint('http://127.0.0.1:19083','wallet').hostname,'127.0.0.1');
  assert.throws(()=>localEndpoint('http://example.com','wallet'));assert.throws(()=>localEndpoint('http://name:pass@localhost','wallet'));
});

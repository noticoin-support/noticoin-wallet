import {backup,DatabaseSync} from 'node:sqlite';
import {existsSync,readFileSync,readdirSync} from 'node:fs';
import {link,unlink} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import path from 'node:path';
export function createLocalDb(file, migrations=path.resolve(import.meta.dirname,'../drizzle')) {
 const sqlite=new DatabaseSync(file);sqlite.exec('PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; CREATE TABLE IF NOT EXISTS _local_migrations(name TEXT PRIMARY KEY);');
 const completed=sqlite.prepare('SELECT name FROM _local_migrations WHERE name=?');
 const record=sqlite.prepare('INSERT INTO _local_migrations(name) VALUES(?)');
 for(const name of readdirSync(migrations).filter(n=>n.endsWith('.sql')).sort()){
  if(completed.get(name))continue;
  sqlite.exec('BEGIN IMMEDIATE');
  try{
   if(!completed.get(name)){
    const initialAlreadyExists=name==='0000_noticoin.sql'&&sqlite.prepare("SELECT name FROM sqlite_master WHERE name='points'").get();
    if(!initialAlreadyExists)sqlite.exec(readFileSync(path.join(migrations,name),'utf8'));
    record.run(name);
   }
   sqlite.exec('COMMIT');
  }catch(error){
   sqlite.exec('ROLLBACK');
   sqlite.close();
   throw error;
  }
 }
 function statement(sql,params=[]){return{bind(...p){return statement(sql,p)},async first(){return sqlite.prepare(sql).get(...params)||null},async all(){return{results:sqlite.prepare(sql).all(...params)}},run(){const r=sqlite.prepare(sql).run(...params);return{meta:{changes:Number(r.changes)}}}}}
 return{prepare:statement,sqlite,async batch(statements){sqlite.exec('BEGIN IMMEDIATE');try{const out=statements.map(s=>s.run());sqlite.exec('COMMIT');return out}catch(e){sqlite.exec('ROLLBACK');throw e}}};
}

export async function openMapDb(directory) {
 const current=path.join(directory,'noticoin-v3.sqlite');
 const previous=path.join(directory,'\x6b\x6f\x6b\x6f-v3.sqlite');
 if(!existsSync(current)&&existsSync(previous))return createLocalDb(previous);
 const prior=path.join(directory,'\x6b\x6f\x6b\x6f.sqlite');
 if(existsSync(current)||!existsSync(prior))return createLocalDb(current);
 const staged=current+'.'+randomUUID()+'.tmp';
 try {
  const source=new DatabaseSync(prior,{readOnly:true});
  try { await backup(source,staged); } finally { source.close(); }
  const {sqlite}=createLocalDb(staged);
  try {
   sqlite.exec(`BEGIN IMMEDIATE;
    CREATE TEMP TABLE legacy_payment_points AS
      SELECT points.id FROM points LEFT JOIN point_details ON point_details.point_id=points.id
      WHERE points.mode='paid' OR point_details.secret_price IS NOT NULL;
    DELETE FROM invoices;
    DELETE FROM secret_purchases;
    DELETE FROM votes WHERE point_id IN (SELECT id FROM legacy_payment_points);
    DELETE FROM permanent_points WHERE point_id IN (SELECT id FROM legacy_payment_points);
    DELETE FROM point_details WHERE point_id IN (SELECT id FROM legacy_payment_points);
    DELETE FROM points WHERE id IN (SELECT id FROM legacy_payment_points);
    UPDATE point_details SET donation_amount=CASE
      WHEN CAST(donation_amount AS INTEGER)>=1000 THEN CAST(CAST(donation_amount AS INTEGER)/1000 AS TEXT)
      ELSE NULL END WHERE donation_amount IS NOT NULL;
    DROP TABLE legacy_payment_points;
    COMMIT;
    PRAGMA wal_checkpoint(TRUNCATE);`);
  } finally { sqlite.close(); }
  try { await link(staged,current); } catch(error) { if(error.code!=='EEXIST')throw error; }
 } finally { await unlink(staged).catch(()=>{}); }
 return createLocalDb(current);
}

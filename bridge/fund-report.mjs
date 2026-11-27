import { readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';

function atomic(value) {
  if ((typeof value === 'number' && !Number.isSafeInteger(value)) || !/^\d+$/.test(String(value))) {
    throw Error('Invalid atomic amount in fund wallet history');
  }
  return BigInt(value);
}

function expensePurpose(value) {
  const clean = text => typeof text === 'string' ? text.trim().slice(0, 240) : '';
  if (!value || typeof value !== 'object' || Array.isArray(value)) return clean(value);
  const translations = {};
  for (const [language, description] of Object.entries(value)) {
    const text = clean(description);
    if (/^[a-z]{2}$/.test(language) && text) translations[language] = text;
  }
  return Object.keys(translations).length ? translations : '';
}

export function fundReport(history, { network, height, confirmations, accountAddress, purposes = {}, balance }) {
  const confirmed = tx => Number(tx.height) > 0 && Number(tx.height) + confirmations - 1 <= height && Number(tx.confirmations) >= confirmations;
  const months = new Map();
  const deposits = new Map();
  let received = 0n;
  let spent = 0n;
  let fees = 0n;
  for (const tx of (history.in || []).filter(confirmed)) {
    if (!/^[a-f0-9]{64}$/.test(tx.txid)) throw Error('Invalid deposit transaction ID');
    const date = new Date(Number(tx.timestamp) * 1000).toISOString();
    const month = date.slice(0, 7);
    deposits.set(tx.txid, { id: tx.txid, height: Number(tx.height), date });
    const amount = atomic(tx.amount);
    months.set(month, (months.get(month) ?? 0n) + amount);
    received += amount;
  }
  const expenses = (history.out || []).filter(confirmed).map(tx => {
    if (!/^[a-f0-9]{64}$/.test(tx.txid)) throw Error('Invalid expense transaction ID');
    const amount = atomic(tx.amount);
    const fee = atomic(tx.fee);
    spent += amount;
    fees += fee;
    const purpose = expensePurpose(purposes[tx.txid]);
    return { id: tx.txid, date: new Date(Number(tx.timestamp) * 1000).toISOString(), amountAtomic: String(amount), feeAtomic: String(fee), purpose };
  }).sort((a, b) => b.date.localeCompare(a.date) || a.id.localeCompare(b.id));
  return {
    network, height, confirmations, accountAddress, updatedAt: new Date().toISOString(),
    totals: { receivedAtomic: String(received), spentAtomic: String(spent), feesAtomic: String(fees), netAtomic: String(received - spent - fees),
      balanceAtomic: String(atomic(balance.balance)), unlockedAtomic: String(atomic(balance.unlocked_balance)) },
    receipts: [...months].sort(([a], [b]) => b.localeCompare(a)).map(([month, amount]) => ({ month, amountAtomic: String(amount) })),
    deposits: [...deposits.values()].sort((a, b) => b.height - a.height || a.id.localeCompare(b.id)).slice(0, 50),
    expenses,
  };
}

export async function publishFundReport(file, wallet, metadata, purposesFile) {
  const purposes = purposesFile ? JSON.parse(await readFile(purposesFile, 'utf8')) : {};
  if (!purposes || Array.isArray(purposes) || typeof purposes !== 'object') throw Error('Invalid fund expense descriptions');
  const history = await wallet('get_transfers', { in: true, out: true, all_accounts: true });
  const balance = await wallet('get_balance', { all_accounts: true });
  const report = fundReport(history, { ...metadata, purposes, balance });
  const staged = file + '.' + randomUUID() + '.tmp';
  try {
    await writeFile(staged, JSON.stringify(report) + '\n', { flag: 'wx' });
    await rename(staged, file);
  } finally {
    await unlink(staged).catch(error => { if (error.code !== 'ENOENT') throw error; });
  }
}

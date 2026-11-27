import {parentPort,workerData} from 'node:worker_threads';
import {packTiles} from './tile-archive.mjs';

const bytes = packTiles(workerData.tiles, workerData.metadata);
parentPort.postMessage(bytes);

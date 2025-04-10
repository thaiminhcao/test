// worker.js
const { parentPort } = require('worker_threads');
const { randomx_create_vm, randomx_init_cache } = require('randomx.js');;

const handleMessage = (message) => {
  if (message.type !== 'job') return;

  console.log('Received mining job:', {
    job_id: message.job_id,
    start: message.startNonce,
    end: message.endNonce
  });

  const { blob, target, startNonce, endNonce, job_id } = message;
  const cache = randomx_init_cache('test key 000');
  const randomx = randomx_create_vm(cache);
  const blobBuffer = Buffer.from(blob, 'hex');
  const workBuffer = Buffer.alloc(blobBuffer.length);
  const targetValue = BigInt('0x' + target);
  let found = false;

  console.time(`Job ${job_id} processing`);

  for (let nonce = startNonce; nonce < endNonce; nonce++) {
    blobBuffer.copy(workBuffer);
    workBuffer.writeUInt32LE(nonce, workBuffer.length - 4);

    const hash = randomx.calculate_hex_hash(workBuffer.toString('hex'));
    const hashValue = BigInt('0x' + hash);

    if (hashValue < targetValue) {
      console.log(`Found valid nonce: ${nonce.toString(16)}`);
      const result = {
        found: true,
        job_id,
        nonce: nonce.toString(16),
        hash
      };

      // Post result to parent
      if (parentPort) {
        parentPort.postMessage(result);
      } else {
        process.send(result);
      }

      found = true;
      process.exit(0);
      break;
    }
  }

  if (!found) {
    console.log(`Job ${job_id} completed without solution`);
    if (parentPort) {
      parentPort.postMessage({ found: false });
    } else {
      process.send({ found: false });
    }
  }

  console.timeEnd(`Job ${job_id} processing`);
};

if (parentPort) {
  // Worker Threads implementation
  parentPort.on('message', handleMessage);
} else {
  // Cluster implementation
  process.on('message', handleMessage);

  // Add cluster-specific logging
  process.on('message', (message) => {
    if (message.type === 'init') {
      console.log(`Cluster worker ${process.pid} initialized`);
    }
  });
}

process.on('exit', (code) => {
  console.log(`Worker ${process.pid} exiting with code ${code}`);
});
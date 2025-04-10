const EventEmitter = require('events');
const net = require('net');
const dns = require('dns');
const os = require('os');
const { Worker, isMainThread, parentPort } = require('worker_threads');
const { randomx_create_vm, randomx_init_cache, randomx_machine_id } = require('randomx.js');

class Blob extends EventEmitter {
    constructor(params) {
        super();

        const { host, port, wallet, password, workerId = '001', algo } = params;

        this.host = host;
        this.port = port;
        this.wallet = wallet;
        this.password = password;
        this.workerId = workerId;
        this.algo = algo;
        this.clientId = null;
        this.ip = null;
        this.client = null;
        this.agent = 'node-rx/0.1';
    }

    submit(result) {
        if (!this.clientId) return;

        const submit = {
            id: 1,
            method: 'submit',
            params: {
                id: this.clientId,
                job_id: result.job_id,
                nonce: result.nonce,
                result: result.result
            }
        };

        this.client.write(JSON.stringify(submit) + '\n');
    }

    connect() {
        return new Promise((resolve, reject) => {
            dns.lookup(this.host, (err, address) => {
                if (err) {
                    console.error('DNS lookup failed:', err);
                    this.emit('error', { error: err });
                    return reject(err);
                }

                this.ip = address;
                console.log(`Resolved pool IP: ${address}`);
                this.emit('connected', { host: this.host, ip: address });

                const client = new net.Socket();
                this.client = client;

                client.connect(this.port, address, () => {
                    console.log(`Connected to ${this.host}:${this.port}`);
                    const login = {
                        id: 1,
                        method: 'login',
                        params: {
                            login: this.wallet,
                            pass: this.password,
                            rigid: this.workerId,
                            agent: this.agent
                        }
                    };
                    client.write(JSON.stringify(login) + '\n');
                    resolve();
                });

                client.on('data', (data) => {
                    const messageStr = data.toString().trim();
                    console.log(`Received from pool: ${messageStr}`);  // Log raw response

                    try {
                        const message = JSON.parse(messageStr);
                        console.log('Parsed pool message:', message);

                        if (message.id == 1 && !message.error && message.result) {
                            if (message.result.id) {
                                this.clientId = message.result.id;
                            } else if (message.result.status === 'OK') {
                                this.emit('shared', { status: 'OK' });
                            }
                        }

                        if (message.method === 'job' || message.result?.job) {
                            const job = message.method === 'job' ? message.params : message.result.job;
                            this.emit('work', job);
                        }

                        if (message.error) {
                            this.emit('rejected', { message: message.error.message });
                        }
                    } catch (error) {
                        console.error('Failed to parse pool message:', error);
                        this.emit('error', { error });
                    }
                });

                client.on('error', (error) => {
                    console.error('Socket error:', error);
                    this.emit('error', { error });
                    reject(error);
                });

                client.on('close', () => {
                    console.log('Connection closed');
                    this.emit('disconnected', { host: this.host, port: this.port });
                });
            });
        });
    }
}

class MiningManager {
    constructor(proxy) {
        this.proxy = proxy;
        this.currentJob = null;
        this.workers = [];
        this.maxWorkers = Math.max(1, os.cpus().length);
        this.solutionFound = false;
    }

    start() {
        this.proxy.on('work', (job) => this.handleNewJob(job));
        this.proxy.on('error', (err) => this.handleProxyError(err));

        const connectToPool = () => {
            this.proxy.connect()
                .then(() => console.log('Successfully connected to pool'))
                .catch(err => {
                    console.error('Connection error:', err.message);
                    console.log('Reconnecting in 5 seconds...');
                    setTimeout(connectToPool, 5000);
                });
        };

        connectToPool();
    }

    terminateWorkers() {
        for (const worker of this.workers) {
            worker.terminate();
        }
        this.workers = [];
    }

    handleNewJob(job) {
        if (!job.blob || !job.job_id || !job.target) return;

        this.terminateWorkers();
        this.currentJob = job;
        this.solutionFound = false;

        const nonceRange = 0xFFFFFFFF;
        const chunkSize = Math.floor(nonceRange / this.maxWorkers);

        for (let i = 0; i < this.maxWorkers; i++) {
            const worker = new Worker(__filename);
            this.workers.push(worker);

            worker.on('message', (msg) => {
                if (msg.found && !this.solutionFound) {
                    this.solutionFound = true;
                    this.proxy.submit(msg);
                    this.terminateWorkers();
                }
            });

            worker.postMessage({
                type: 'job',
                blob: job.blob,
                job_id: job.job_id,
                target: job.target,
                startNonce: i * chunkSize,
                endNonce: (i + 1) * chunkSize
            });
        }
    }

    handleProxyError(err) {
        console.error('Proxy error:', err);
        setTimeout(() => this.proxy.connect(), 5000);
    }
}

if (isMainThread) {
    const proxy = new Blob({
        host: '103.130.213.139',
        port: 6122,
        wallet: '45R6ZmMuwKMjdsg6zGVM85hMdz5qjBb9hAJWueDaXAKz7bHPafajD6HHU3WEbjRu5eE85pSnekUE41e6HGjvBKNE3dC45rQ',
        password: 'x',
        workerId: `worker-${process.pid}`
    });

    const manager = new MiningManager(proxy);
    manager.start();

    process.on('SIGINT', () => {
        console.log('\nShutting down gracefully...');
        manager.terminateWorkers();
        process.exit(0);
    });
} else {
    parentPort.on('message', (message) => {
        if (message.type === 'job') {
            const { blob, target, startNonce, endNonce, job_id } = message;
            const cache = randomx_init_cache('test key 000');
            const randomx = randomx_create_vm(cache);
            const blobBuffer = Buffer.from(blob, 'hex');
            const workBuffer = Buffer.alloc(blobBuffer.length);
            const targetValue = BigInt('0x' + target);

            for (let nonce = startNonce; nonce < endNonce; nonce++) {
                blobBuffer.copy(workBuffer);
                workBuffer.writeUInt32LE(nonce, workBuffer.length - 4);

                const hash = randomx.calculate_hex_hash(workBuffer.toString('hex'));
                const hashValue = BigInt('0x' + hash);

                if (hashValue < targetValue) {
                    parentPort.postMessage({
                        found: true,
                        job_id,
                        nonce: nonce.toString(16),
                        hash
                    });
                    process.exit(0);
                }
            }
            parentPort.postMessage({ found: false });
        }
    });
}
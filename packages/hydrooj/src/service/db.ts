/* eslint-disable no-await-in-loop */
import {
    Collection, Db, IndexSpecification, MongoClient,
} from 'mongodb';
import { Logger } from '../logger';
import options from '../options';
import * as bus from './bus';

const logger = new Logger('mongo');
export interface Collections { }

interface MongoConfig {
    protocol?: string,
    username?: string,
    password?: string,
    host?: string,
    port?: string,
    name?: string,
    url?: string,
    uri?: string,
    prefix?: string,
}

class MongoService {
    public client: MongoClient;
    public db: Db;
    private opts: MongoConfig;

    static buildUrl(opts: MongoConfig) {
        let mongourl = `${opts.protocol || 'mongodb'}://`;
        if (opts.username) mongourl += `${opts.username}:${encodeURIComponent(opts.password)}@`;
        mongourl += `${opts.host}:${opts.port}/${opts.name}`;
        if (opts.url || opts.uri) mongourl = opts.url || opts.uri;
        return mongourl;
    }

    async start() {
        const opts = options() || {};
        let mongourl = MongoService.buildUrl(opts);
        if (process.env.CI) {
            const { MongoMemoryServer } = require('mongodb-memory-server');
            const mongod = await MongoMemoryServer.create();
            mongourl = mongod.getUri();
        }
        this.opts = opts;
        this.client = await MongoClient.connect(mongourl, {
            useNewUrlParser: true,
            useUnifiedTopology: true,
            readPreference: 'nearest',
            writeConcern: 'majority',
        });
        this.db = this.client.db(opts.name || 'hydro');
        await bus.parallel('database/connect', this.db);
    }

    public collection<K extends keyof Collections>(c: K): Collection<Collections[K]> {
        if (this.opts.prefix) return this.db.collection(`${this.opts.prefix}.${c}`);
        return this.db.collection(c);
    }

    public async ensureIndexes<T>(coll: Collection<T>, ...args: IndexSpecification[]) {
        if (process.env.NODE_APP_INSTANCE !== '0') return;
        let existed: any[];
        try {
            existed = await coll.listIndexes().toArray();
        } catch (e) {
            existed = [];
        }
        for (const index of args) {
            let i = existed.find((t) => t.name === index.name || JSON.stringify(t.key) === JSON.stringify(index.key));
            if (!i && Object.keys(index.key).map((k) => index.key[k]).includes('text')) {
                i = existed.find((t) => t.textIndexVersion);
            }
            index.background = true;
            if (!i) {
                logger.info('Indexing %s.%s with key %o', coll.collectionName, index.name, index.key);
                await coll.createIndexes([index]);
            } else if (i.v < 2 || i.name !== index.name || JSON.stringify(i.key) !== JSON.stringify(index.key)) {
                if (i.textIndexVersion) {
                    const cur = Object.keys(i.key).filter((t) => !t.startsWith('_')).map((k) => `${k}:${i.key[k]}`);
                    for (const key of Object.keys(i.weights)) cur.push(`${key}:text`);
                    const wanted = Object.keys(index.key).map((key) => `${key}:${index.key[key]}`);
                    if (cur.sort().join(' ') === wanted.sort().join(' ') && i.name === index.name) continue;
                }
                logger.info('Re-Index %s.%s with key %o', coll.collectionName, index.name, index.key);
                await coll.dropIndex(i.name);
                await coll.createIndexes([index]);
            }
        }
    }

    public async apply(ctx) {
        await this.start();
        ctx.on('dispose', () => this.client.close());
    }
}

const service = new MongoService();
global.Hydro.service.db = service;
export default service;
export const collection = service.collection.bind(service);

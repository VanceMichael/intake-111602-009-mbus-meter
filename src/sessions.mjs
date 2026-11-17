import { randomUUID } from 'node:crypto';
import { mkdir, open, readFile, readdir, rename } from 'node:fs/promises';
import { join } from 'node:path';

// 领取会话的持久化：进度（已收帧摘要、下一帧计数位）与设备身份落盘，
// 中断后可核对、可继续。帧原件由 Catalog 按内容摘要保存，此处只引用摘要。
export class SessionStore {
  constructor(root) {
    this.dir = join(root, 'sessions');
    this.serial = Promise.resolve();
  }

  async initialize() {
    await mkdir(this.dir, { recursive: true });
    return this;
  }

  async atomic(path, bytes) {
    const temporary = `${path}.${randomUUID()}.tmp`;
    const handle = await open(temporary, 'wx');
    try {
      await handle.writeFile(bytes);
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(temporary, path);
  }

  async create({ source, path }) {
    const session = {
      id: randomUUID(),
      source,
      path,
      device: null,
      status: 'in-progress',
      error: null,
      fcb: 1,
      frames: [],
      rejected: [],
      startedAt: new Date().toISOString(),
      updatedAt: null,
      completedAt: null,
    };
    await this.save(session);
    return session;
  }

  async save(session) {
    await this.initialize();
    session.updatedAt = new Date().toISOString();
    const operation = this.serial.then(() =>
      this.atomic(join(this.dir, `${session.id}.json`), Buffer.from(JSON.stringify(session, null, 2))));
    this.serial = operation.catch(() => {});
    return operation.then(() => session);
  }

  async get(id) {
    if (!/^[0-9a-f-]{36}$/.test(id)) throw new Error('无效的会话编号');
    return JSON.parse(await readFile(join(this.dir, `${id}.json`), 'utf8'));
  }

  async list() {
    await this.initialize();
    const files = (await readdir(this.dir)).filter(name => name.endsWith('.json')).sort();
    return Promise.all(files.map(name => readFile(join(this.dir, name), 'utf8').then(JSON.parse)));
  }
}

'use strict';

// Minimal CDP client over the WebSocket built into Node 22 (no dependencies).
class CDPClient {
  constructor(url) {
    this.url = url;
    this.nextId = 1;
    this.pending = new Map();
    this.listeners = new Map();
    this.ws = null;
    this.closed = false;
  }

  connect() {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(this.url);
      this.ws = ws;
      ws.addEventListener('open', () => resolve(this));
      ws.addEventListener('error', (err) => {
        if (this.pending.size === 0 && !this.closed) reject(new Error('CDP websocket error'));
      });
      ws.addEventListener('close', () => {
        this.closed = true;
        for (const { reject: rej } of this.pending.values()) {
          rej(new Error('CDP connection closed'));
        }
        this.pending.clear();
        this._emit('__disconnected__', {});
      });
      ws.addEventListener('message', (event) => {
        let msg;
        try {
          msg = JSON.parse(event.data);
        } catch (e) {
          return;
        }
        if (msg.id && this.pending.has(msg.id)) {
          const { resolve: res, reject: rej } = this.pending.get(msg.id);
          this.pending.delete(msg.id);
          if (msg.error) rej(new Error(`${msg.error.message} (${msg.method || ''})`));
          else res(msg.result);
        } else if (msg.method) {
          this._emit(msg.method, msg.params || {}, msg.sessionId);
        }
      });
    });
  }

  send(method, params = {}, sessionId) {
    if (this.closed) return Promise.reject(new Error('CDP connection closed'));
    const id = this.nextId++;
    const payload = { id, method, params };
    if (sessionId) payload.sessionId = sessionId;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      try {
        this.ws.send(JSON.stringify(payload));
      } catch (e) {
        this.pending.delete(id);
        reject(e);
      }
    });
  }

  on(method, handler) {
    if (!this.listeners.has(method)) this.listeners.set(method, []);
    this.listeners.get(method).push(handler);
  }

  _emit(method, params, sessionId) {
    const handlers = this.listeners.get(method);
    if (!handlers) return;
    for (const handler of handlers) {
      try {
        handler(params, sessionId);
      } catch (e) {
        // A failing handler must not kill the connection.
      }
    }
  }

  close() {
    this.closed = true;
    try {
      this.ws.close();
    } catch (e) {}
  }
}

module.exports = { CDPClient };

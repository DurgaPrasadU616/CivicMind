import { Response } from 'express';
import { logger } from '../config/logger';

class SSEManager {
  private clients: Map<string, Response> = new Map();
  private clientRoles: Map<string, string> = new Map();
  private connectionTimestamps: Map<string, number> = new Map();

  addClient(id: string, res: Response, role?: string): void {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });

    res.write(`data: ${JSON.stringify({ type: 'connected', clientId: id })}\n\n`);

    this.clients.set(id, res);
    if (role) this.clientRoles.set(id, role);
    this.connectionTimestamps.set(id, Date.now());

    logger.info(`SSE client connected: ${id} (role: ${role || 'unknown'})`);

    const heartbeat = setInterval(() => {
      try {
        res.write(`:heartbeat\n\n`);
      } catch {
        clearInterval(heartbeat);
        this.removeClient(id);
      }
    }, 30000);

    res.on('close', () => {
      clearInterval(heartbeat);
      this.removeClient(id);
    });
  }

  removeClient(id: string): void {
    this.clients.delete(id);
    this.clientRoles.delete(id);
    this.connectionTimestamps.delete(id);
    logger.info(`SSE client disconnected: ${id}`);
  }

  broadcast(event: string, data: unknown, allowedRoles?: string[]): void {
    const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;

    this.clients.forEach((res, id) => {
      if (allowedRoles) {
        const role = this.clientRoles.get(id);
        if (!role || !allowedRoles.includes(role)) return;
      }
      try {
        res.write(payload);
      } catch {
        this.removeClient(id);
      }
    });
  }

  sendToClient(clientId: string, event: string, data: unknown): void {
    const res = this.clients.get(clientId);
    if (!res) return;

    try {
      res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    } catch {
      this.removeClient(clientId);
    }
  }

  get connectedCount(): number {
    return this.clients.size;
  }
}

export const sseManager = new SSEManager();
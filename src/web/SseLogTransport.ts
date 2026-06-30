import TransportStream from 'winston-transport'
import { Response } from 'express'
import stripAnsi from 'strip-ansi'

// SSEクライアントを管理するシングルトン
class SseManager {
    private clients: Map<string, Response> = new Map()

    add(id: string, res: Response): void {
        this.clients.set(id, res)
    }

    remove(id: string): void {
        this.clients.delete(id)
    }

    broadcast(data: object): void {
        const payload = `data: ${JSON.stringify(data)}\n\n`
        for (const res of this.clients.values()) {
            res.write(payload)
        }
    }
}

export const sseManager = new SseManager()

export class SseLogTransport extends TransportStream {
    override log(info: { level: string; message: string }, callback: () => void): void {
        setImmediate(() => this.emit('logged', info))
        sseManager.broadcast({
            type: 'log',
            level: info.level.replace(/\[[0-9;]*m/g, ''),
            message: stripAnsi(String(info.message))
        })
        callback()
    }
}

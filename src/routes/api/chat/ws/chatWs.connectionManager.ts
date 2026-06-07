import { randomUUID } from 'node:crypto';

import type WebSocket from 'ws';
import type { UserId } from 'types/ids.js';
import type { Role } from 'types/user.js';

interface AddChatSocketDto {
    socket: WebSocket;
    actorId: UserId;
    actorRole: Role;
}

export interface ChatSocketContext {
    socketId: string;
    actorId: UserId;
    actorRole: Role;
    joinedThreads: Set<string>;
}

class ChatWsConnectionManager {
    private sockets = new Map<string, WebSocket>();
    private contexts = new Map<string, ChatSocketContext>();
    private threadSockets = new Map<string, Set<string>>();
    private adminSockets = new Set<string>();

    // register socket connection
    add({ socket, actorId, actorRole }: AddChatSocketDto): string {
        const socketId = randomUUID();

        this.sockets.set(socketId, socket);

        this.contexts.set(socketId, {
            socketId,
            actorId,
            actorRole,
            joinedThreads: new Set(),
        });

        if (actorRole === 'ADMIN' || actorRole === 'ROOT') {
            this.adminSockets.add(socketId);
        }

        return socketId;
    }

    // remove socket connection
    remove(socketId: string): void {
        const context = this.contexts.get(socketId);

        if (context) {
            for (const threadId of [...context.joinedThreads]) {
                this.leaveThread(socketId, threadId);
            }
        }

        this.adminSockets.delete(socketId);
        this.contexts.delete(socketId);
        this.sockets.delete(socketId);
    }

    // get socket instance
    getSocket(socketId: string): WebSocket | null {
        return this.sockets.get(socketId) ?? null;
    }

    // get socket context
    getContext(socketId: string): ChatSocketContext | null {
        return this.contexts.get(socketId) ?? null;
    }

    // join socket to thread
    joinThread(socketId: string, threadId: string): void {
        const context = this.contexts.get(socketId);

        if (!context) return;

        let socketIds = this.threadSockets.get(threadId);

        if (!socketIds) {
            socketIds = new Set();
            this.threadSockets.set(threadId, socketIds);
        }

        socketIds.add(socketId);
        context.joinedThreads.add(threadId);
    }

    // remove socket from thread
    leaveThread(socketId: string, threadId: string): void {
        const context = this.contexts.get(socketId);
        const socketIds = this.threadSockets.get(threadId);

        context?.joinedThreads.delete(threadId);
        socketIds?.delete(socketId);

        if (socketIds?.size === 0) {
            this.threadSockets.delete(threadId);
        }
    }

    // get sockets by thread
    getThreadSockets(threadId: string): WebSocket[] {
        const socketIds = this.threadSockets.get(threadId);

        if (!socketIds) return [];

        return [...socketIds]
            .map((socketId) => this.sockets.get(socketId))
            .filter((socket): socket is WebSocket => Boolean(socket));
    }

    // get active admin sockets
    getAdminSockets(): WebSocket[] {
        return [...this.adminSockets]
            .map((socketId) => this.sockets.get(socketId))
            .filter((socket): socket is WebSocket => Boolean(socket));
    }

    // remove all sockets from thread
    removeThread(threadId: string): void {
        const socketIds = this.threadSockets.get(threadId);

        if (!socketIds) return;

        for (const socketId of socketIds) {
            const context = this.contexts.get(socketId);

            context?.joinedThreads.delete(threadId);
        }

        this.threadSockets.delete(threadId);
    }
}

export const chatWsConnectionManager = new ChatWsConnectionManager();
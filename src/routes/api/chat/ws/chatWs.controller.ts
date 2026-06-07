import type { FastifyRequest } from 'fastify';
import type WebSocket from 'ws';
import type { RawData } from 'ws';
import type { User } from 'types/user.js';

import { chatWsBroadcaster } from './chatWs.broadcaster.js';
import { chatWsConnectionManager } from './chatWs.connectionManager.js';
import { chatWsHandlers } from './chatWs.handlers.js';

function connectChatWs(socket: WebSocket, req: FastifyRequest): void {
    const { id: actorId, role: actorRole } = req.user as User;

    // register socket context
    const socketId = chatWsConnectionManager.add({
        socket,
        actorId,
        actorRole,
    });

    // notify client about connection
    chatWsBroadcaster.sendToSocket(socketId, {
        type: 'connection:ready',
        payload: {
            socketId,
        },
    });

    // handle incoming events
    socket.on('message', (raw: RawData) => {
        void chatWsHandlers.handleMessage({
            socketId,
            raw,
        });
    });

    // cleanup closed connection
    socket.on('close', () => {
        chatWsConnectionManager.remove(socketId);
    });

    // cleanup errored connection
    socket.on('error', () => {
        chatWsConnectionManager.remove(socketId);
    });
}

export const chatWsController = {
    connectChatWs,
};
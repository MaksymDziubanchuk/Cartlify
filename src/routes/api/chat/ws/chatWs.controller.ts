import type { FastifyRequest } from 'fastify';
import type WebSocket from 'ws';
import type { RawData } from 'ws';
import type { User } from 'types/user.js';

import { chatWsBroadcaster } from './chatWs.broadcaster.js';
import { chatWsConnectionManager } from './chatWs.connectionManager.js';
import { chatWsHandlers } from './chatWs.handlers.js';

// the close codes the frontend tells apart: renew the session and connect again
export const SESSION_CLOSE_CODE = 4401;

function connectChatWs(socket: WebSocket, req: FastifyRequest): void {
    const { id: actorId, role: actorRole } = req.user as User;

    // a socket lives no longer than its access token: a role taken away, a logout or a deleted
    // account would go on with an open socket for hours; the frontend renews the session and
    // connects again. A guest has no token
    const expiresAt = req.accessTokenExpiresAt;
    const expiry = expiresAt
        ? setTimeout(
              () => socket.close(SESSION_CLOSE_CODE, 'SESSION_EXPIRED'),
              Math.max(0, expiresAt - Date.now()),
          )
        : null;
    expiry?.unref?.();

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
            log: req.log,
        });
    });

    // cleanup closed connection
    socket.on('close', () => {
        if (expiry) clearTimeout(expiry);
        chatWsConnectionManager.remove(socketId);
    });

    // cleanup errored connection
    socket.on('error', () => {
        if (expiry) clearTimeout(expiry);
        chatWsConnectionManager.remove(socketId);
    });
}

export const chatWsController = {
    connectChatWs,
};
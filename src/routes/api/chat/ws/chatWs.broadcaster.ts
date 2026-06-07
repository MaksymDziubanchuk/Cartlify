import WebSocket from 'ws';

import { chatWsConnectionManager } from './chatWs.connectionManager.js';

import type { ChatWsServerEventType } from 'types/dto/chats.dto.js';

interface ChatWsServerEvent {
    type: ChatWsServerEventType;
    payload?: unknown;
}

interface ChatWsErrorPayload {
    code: string;
    message?: string;
}

// send event to socket
function send(socket: WebSocket, event: ChatWsServerEvent): void {
    if (socket.readyState !== WebSocket.OPEN) return;

    socket.send(JSON.stringify(event));
}

// send event to exact socket
function sendToSocket(socketId: string, event: ChatWsServerEvent): void {
    const socket = chatWsConnectionManager.getSocket(socketId);

    if (!socket) return;

    send(socket, event);
}

// send event to all sockets joined to thread
function broadcastToThread(threadId: string, event: ChatWsServerEvent): void {
    const sockets = chatWsConnectionManager.getThreadSockets(threadId);

    for (const socket of sockets) {
        send(socket, event);
    }
}

// send event to all active admins
function broadcastToAdmins(event: ChatWsServerEvent): void {
    const sockets = chatWsConnectionManager.getAdminSockets();

    for (const socket of sockets) {
        send(socket, event);
    }
}

// send ws error
function sendError(socketId: string, payload: ChatWsErrorPayload): void {
    sendToSocket(socketId, {
        type: 'error',
        payload,
    });
}

export const chatWsBroadcaster = {
    sendToSocket,
    broadcastToThread,
    broadcastToAdmins,
    sendError,
};
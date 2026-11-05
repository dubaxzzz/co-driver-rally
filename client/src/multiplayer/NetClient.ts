import { P2PNetClient } from './P2PNetClient';
import { SocketNetClient } from './SocketNetClient';
import type { NetBase } from './types';

export { NetError, type ConnStatus } from './types';

/**
 * VITE_TRANSPORT=p2p (the Live Server build in /play) → no server needed.
 * Otherwise → Socket.IO to the Node server.
 */
export const net: NetBase = import.meta.env.VITE_TRANSPORT === 'p2p' ? new P2PNetClient() : new SocketNetClient();

import { SocketNetClient } from './SocketNetClient';
import type { NetBase } from './types';

export { NetError, type ConnStatus } from './types';

/** One Socket.IO connection to the rally server, shared by every screen. */
export const net: NetBase = new SocketNetClient();
if (import.meta.env.DEV) (window as unknown as { __cdrNet: NetBase }).__cdrNet = net;

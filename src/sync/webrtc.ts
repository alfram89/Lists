import {
  getRelaySockets,
  joinRoom,
  pauseRelayReconnection,
  resumeRelayReconnection,
} from 'trystero';
import { MAX_SEALED_BYTES } from '../crypto/seal';
import { APP_ID, ICE_SERVERS, RELAY_URLS } from './config';
import { asBytes, type TransportFactory } from './transport';

/**
 * Trystero keeps its relay connections open globally, even after the last room
 * is left. Counting rooms lets us close them when no shared space is open, so
 * relays do not keep seeing this device online, and reopen them on demand.
 */
let openRooms = 0;

function closeIdleRelayConnections() {
  if (openRooms > 0) return;
  pauseRelayReconnection();
  for (const socket of Object.values(getRelaySockets() as Record<string, WebSocket>)) {
    socket.close();
  }
}

/**
 * Peer-to-peer sync between devices over WebRTC data channels. Trystero finds
 * peers through public Nostr relays, using the derived room id as topic and
 * the derived signal password to encrypt the connection offers it posts there.
 */
export const webrtcTransport: TransportFactory = (room, events) => {
  if (openRooms++ === 0) resumeRelayReconnection();
  const trysteroRoom = joinRoom(
    {
      appId: APP_ID,
      password: room.signalPassword,
      relayConfig: { urls: RELAY_URLS },
      rtcConfig: { iceServers: ICE_SERVERS },
      maxReceiveBytes: MAX_SEALED_BYTES,
    },
    room.roomId,
  );

  const action = trysteroRoom.makeAction<Uint8Array>('sync', {
    onMessage: (data, { peerId }) => {
      const bytes = asBytes(data);
      if (bytes) events.onMessage(bytes, peerId);
    },
  });
  trysteroRoom.onPeerJoin = (peerId) => events.onPeerJoin(peerId);
  trysteroRoom.onPeerLeave = (peerId) => events.onPeerLeave(peerId);

  return {
    remote: true,
    send(data, peerId) {
      action.send(data, peerId ? { target: peerId } : undefined).catch(() => {
        // The peer went away mid-send; it will resync when it reconnects.
      });
    },
    close() {
      void trysteroRoom.leave().finally(() => {
        openRooms--;
        closeIdleRelayConnections();
      });
    },
  };
};
